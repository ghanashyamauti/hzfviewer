"""
HZF & BIN Inspector Studio - FastAPI Backend Server
Loads configuration from .env, manages saved reports in Neon PostgreSQL,
parses .hzf/.bin files, and packages inspections into .hzf, .bin, and PDF.
"""

import os
import json
import uuid
import datetime
from fastapi import FastAPI, UploadFile, File, Response, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from typing import Dict, Any, List, Optional
from dotenv import load_dotenv

from hzf_parser import parse_hzf_bytes, build_hzf_bytes, get_clean_blank_template
from db import (
    init_db, save_report_to_db, list_reports_from_db, get_report_from_db, delete_report_from_db,
    create_user, get_user_by_email, get_user_by_id, update_user_verified, update_user_last_login,
    update_user_password, update_user_active_status, list_all_users, save_otp, verify_otp_in_db, get_connection
)
from auth import (
    hash_password, verify_password, create_access_token, decode_access_token,
    generate_otp, send_otp_email, send_welcome_email, ADMIN_EMAIL, ADMIN_PASSWORD
)
from ai_service import (
    is_ai_configured,
    test_gemini_connection,
    polish_single_item,
    batch_polish_inspection,
    generate_executive_summary
)
from qa_validator import audit_inspection
from pdf_generator import generate_hip_inspection_pdf

# Load environment configuration from backend/.env or parent .env
backend_env = os.path.join(os.path.dirname(__file__), ".env")
root_env = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(backend_env, override=True)
load_dotenv(root_env, override=False)

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
SAVED_DIR = os.getenv("SAVED_REPORTS_DIR", "saved_reports")
CORS_ORIGINS_ENV = os.getenv("CORS_ORIGINS", "*")
APP_NAME = os.getenv("APP_NAME", "HZF & BIN Inspector Studio API")
APP_VERSION = os.getenv("APP_VERSION", "2.3.0")
APP_ENV = os.getenv("APP_ENV", "production")
DEBUG_MODE = os.getenv("DEBUG", "False").lower() in ("true", "1", "yes")

# Ensure local backup directory exists
saved_reports_path = os.path.join(os.path.dirname(__file__), SAVED_DIR)
os.makedirs(saved_reports_path, exist_ok=True)

# Initialize PostgreSQL database
init_db()

app = FastAPI(
    title=APP_NAME,
    description="Backend services for storing and generating .hzf/.bin inspections",
    version=APP_VERSION,
    debug=DEBUG_MODE
)

# Mount static assets for wall diagrams and default branding
assets_path = os.path.join(os.path.dirname(__file__), "assets")
if os.path.exists(assets_path):
    from fastapi.staticfiles import StaticFiles
    app.mount("/assets", StaticFiles(directory=assets_path), name="assets")

# CORS Setup for Vercel / Cloud Deployments
if CORS_ORIGINS_ENV == "*":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in CORS_ORIGINS_ENV.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


class InspectionPayload(BaseModel):

    id: Optional[str] = None
    fileName: str = "Inspection_Report.hzf"
    clientInfo: Dict[str, Any] = {}
    sections: List[Dict[str, Any]] = []
    coverPhoto: Optional[str] = None
    inspectorInfo: Optional[Dict[str, str]] = None

class ExportPdfPayload(BaseModel):
    id: Optional[str] = None
    fileName: str = "Inspection_Report.pdf"
    clientInfo: Dict[str, Any] = {}
    sections: List[Dict[str, Any]] = []
    coverPhoto: Optional[str] = None
    inspectorInfo: Optional[Dict[str, str]] = None

class PolishItemPayload(BaseModel):
    sectionName: str
    itemName: str
    status: str
    rawComments: Optional[str] = ""
    photosCount: Optional[int] = 0
    photos: Optional[List[Dict[str, Any]]] = []

class SetApiKeyPayload(BaseModel):
    apiKey: str
    model: Optional[str] = None

class RegisterPayload(BaseModel):
    name: str
    email: str
    phone: Optional[str] = ""
    organization: Optional[str] = ""
    password: str

class VerifyOtpPayload(BaseModel):
    email: str
    otp: Optional[str] = None
    otp_code: Optional[str] = None

class ResendOtpPayload(BaseModel):
    email: str

class LoginPayload(BaseModel):
    email: str
    password: str

class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    email: str
    otp: str
    new_password: str

def get_current_user_from_req(request: Request) -> Optional[Dict[str, Any]]:
    """Helper to extract user record from Authorization Bearer token header."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ", 1)[1].strip()
    payload = decode_access_token(token)
    if not payload or not payload.get("sub"):
        return None
    user = get_user_by_id(payload["sub"])
    if user:
        if user.get("role") != "admin" and (user.get("is_active") is False or user.get("isActive") is False):
            return None
        return user
    # Fallback to verified JWT payload if admin or db query has temporary connection delay
    if payload.get("role") == "admin":
        return {
            "id": payload["sub"],
            "name": payload.get("name", "System Administrator"),
            "email": payload.get("email", "admin@hzfstudio.com"),
            "role": "admin",
            "is_verified": True
        }
    return None


@app.get("/api/config")
async def get_system_config():
    """Return non-sensitive environment configuration loaded from .env."""
    db_reports = list_reports_from_db()
    db_count = len(db_reports) if db_reports is not None else 0
    return {
        "appName": APP_NAME,
        "version": APP_VERSION,
        "environment": APP_ENV,
        "host": HOST,
        "port": PORT,
        "geminiModel": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        "databaseConnected": bool(os.getenv("DATABASE_URL")),
        "savedReportsDir": SAVED_DIR,
        "savedReportsCount": db_count,
        "corsOrigins": CORS_ORIGINS_ENV,
    }

@app.get("/api/health")
async def health_check():
    db_reports = list_reports_from_db()
    db_count = len(db_reports) if db_reports is not None else 0
    return {
        "status": "online",
        "app": APP_NAME,
        "version": APP_VERSION,
        "environment": APP_ENV,
        "database": "Neon PostgreSQL (Connected)" if os.getenv("DATABASE_URL") else "Local Storage",
        "savedReportsCount": db_count
    }


@app.get("/api/template")
async def get_template():
    """Returns clean blank inspection template (Zero Hardcoded Data)."""
    return {
        "success": True,
        "data": get_clean_blank_template()
    }

@app.post("/api/upload-hzf")
async def upload_hzf(file: UploadFile = File(...)):
    """Upload and parse an existing .hzf or .bin file from mobile/desktop."""
    try:
        contents = await file.read()
        if len(contents) == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        parsed_data = parse_hzf_bytes(contents, filename=file.filename or "inspection.hzf")
        return {
            "success": True,
            "data": parsed_data
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse inspection file: {str(e)}")

# ==============================================================================
# AUTHENTICATION & USER MANAGEMENT ENDPOINTS
# ==============================================================================

@app.post("/api/auth/register")
async def register_user(payload: RegisterPayload):
    """Register a new inspector user and dispatch verification OTP via SMTP."""
    email = payload.email.lower().strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Full name is required.")
    if len(payload.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    existing_user = get_user_by_email(email)
    if existing_user and existing_user.get("is_verified"):
        raise HTTPException(status_code=400, detail="Email is already registered and verified. Please log in.")

    hashed_pw = hash_password(payload.password)
    if existing_user and not existing_user.get("is_verified"):
        # Update existing unverified user
        conn = get_connection()
        if conn:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE users 
                    SET name = %s, phone = %s, organization = %s, password_hash = %s
                    WHERE LOWER(email) = %s;
                """, (payload.name.strip(), payload.phone.strip(), payload.organization.strip(), hashed_pw, email))
                conn.commit()
            conn.close()
    else:
        created = create_user(
            name=payload.name,
            email=email,
            phone=payload.phone,
            organization=payload.organization,
            password_hash=hashed_pw,
            role="user",
            is_verified=False
        )
        if not created:
            raise HTTPException(status_code=500, detail="Failed to create user account.")

    # Generate and send OTP
    otp = generate_otp()
    save_otp(email, otp, minutes=10)
    sent, reason = send_otp_email(email, otp, payload.name)

    resp_data = {
        "success": True,
        "email": email,
        "message": f"Verification code sent to {email}. Please enter the 6-digit code to complete sign up."
    }
    if reason == "DEV_LOGGED":
        resp_data["dev_note"] = "SMTP credentials pending in .env: OTP logged to server terminal for testing."
        resp_data["dev_otp"] = otp

    return resp_data


@app.post("/api/auth/verify-otp")
async def verify_otp(payload: VerifyOtpPayload):
    """Verify email OTP code and activate user account."""
    email = payload.email.lower().strip()
    otp = (payload.otp or payload.otp_code or "").strip()
    if not otp:
        raise HTTPException(status_code=400, detail="Verification code is required.")

    verified = verify_otp_in_db(email, otp)
    if not verified:
        raise HTTPException(status_code=400, detail="Invalid or expired verification code.")

    update_user_verified(email)
    user = get_user_by_email(email)
    if not user:
        raise HTTPException(status_code=404, detail="User account not found.")

    # Send official welcome confirmation email
    try:
        send_welcome_email(email, user.get("name", "Inspector"))
    except Exception as e:
        print(f"[Welcome Email Notice] {e}")

    update_user_last_login(user["id"])
    token = create_access_token(user["id"], user["email"], user["role"], user["name"])

    return {
        "success": True,
        "message": "Account verified successfully!",
        "token": token,
        "user": {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "phone": user.get("phone", ""),
            "organization": user.get("organization", ""),
            "role": user["role"]
        }
    }


@app.post("/api/auth/forgot-password/request")
async def forgot_password_request(payload: ForgotPasswordRequest):
    """Request a 6-digit password reset code sent via email."""
    email = payload.email.lower().strip()
    if not email:
        raise HTTPException(status_code=400, detail="Email address is required.")

    # Security: Admin password cannot be reset via forgot password
    if email == ADMIN_EMAIL.lower().strip():
        raise HTTPException(status_code=403, detail="Password reset is disabled for the system administrator account.")

    user = get_user_by_email(email)
    if not user:
        raise HTTPException(status_code=404, detail="No registered inspector account found with this email.")

    if user.get("is_active") is False or user.get("isActive") is False:
        raise HTTPException(status_code=403, detail="This account has been deactivated by the administrator. Please contact your administrator.")

    if not user.get("is_verified"):
        raise HTTPException(status_code=400, detail="This account is not yet verified. Please complete signup verification first.")

    otp = generate_otp()
    save_otp(email, otp, minutes=10)
    sent, reason = send_otp_email(email, otp, user.get("name", "Inspector"), purpose="reset")

    return {
        "success": True,
        "message": f"A 6-digit password reset code has been sent to {email}."
    }


@app.post("/api/auth/forgot-password/reset")
async def forgot_password_reset(payload: ResetPasswordRequest):
    """Verify reset code and update user password."""
    email = payload.email.lower().strip()
    otp = payload.otp.strip()
    new_pw = payload.new_password

    if not email or not otp or not new_pw:
        raise HTTPException(status_code=400, detail="Email, OTP code, and new password are required.")

    if email == ADMIN_EMAIL.lower().strip():
        raise HTTPException(status_code=403, detail="Password reset is disabled for the system administrator account.")

    if len(new_pw) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters.")

    verified = verify_otp_in_db(email, otp)
    if not verified:
        raise HTTPException(status_code=400, detail="Invalid or expired verification code.")

    new_hash = hash_password(new_pw)
    updated = update_user_password(email, new_hash)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update password in database.")

    return {
        "success": True,
        "message": "Password updated successfully! You can now log in with your new password."
    }


@app.post("/api/auth/resend-otp")
async def resend_otp(payload: ResendOtpPayload):
    """Resend a new 6-digit OTP code to user's email."""
    email = payload.email.lower().strip()
    user = get_user_by_email(email)
    if not user:
        raise HTTPException(status_code=404, detail="No registered account found with this email.")

    otp = generate_otp()
    save_otp(email, otp, minutes=10)
    sent, reason = send_otp_email(email, otp, user["name"])

    resp_data = {
        "success": True,
        "message": f"A new verification code has been sent to {email}."
    }
    if reason == "DEV_LOGGED":
        resp_data["dev_note"] = "SMTP credentials pending: OTP logged to server terminal."
        resp_data["dev_otp"] = otp
    return resp_data


@app.post("/api/auth/login")
async def login_user(payload: LoginPayload):
    """Unified user and admin login endpoint."""
    email = payload.email.lower().strip()
    user = get_user_by_email(email)

    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    if not verify_password(payload.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    if user.get("role") != "admin" and (user.get("is_active") is False or user.get("isActive") is False):
        raise HTTPException(
            status_code=403,
            detail="Your account has been deactivated by the administrator. Past inspection reports and records are preserved, but login is currently disabled. Please contact your administrator."
        )

    if not user.get("is_verified"):
        # User signed up but hasn't verified OTP yet
        otp = generate_otp()
        save_otp(email, otp, minutes=10)
        send_otp_email(email, otp, user["name"])
        return {
            "success": False,
            "requires_otp": True,
            "email": email,
            "message": "Your account is not verified yet. We have sent a verification code to your email."
        }

    update_user_last_login(user["id"])
    token = create_access_token(user["id"], user["email"], user["role"], user["name"])

    return {
        "success": True,
        "token": token,
        "user": {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "phone": user.get("phone", ""),
            "organization": user.get("organization", ""),
            "role": user["role"]
        }
    }


@app.get("/api/auth/me")
async def get_current_user_profile(request: Request):
    """Return authenticated user profile from token."""
    user = get_current_user_from_req(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required or token expired.")
    return {
        "success": True,
        "user": {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "phone": user.get("phone", ""),
            "organization": user.get("organization", ""),
            "role": user["role"],
            "createdAt": user.get("createdAt"),
            "lastLogin": user.get("lastLogin")
        }
    }


# ==============================================================================
# ADMIN PANEL ENDPOINTS
# ==============================================================================

@app.get("/api/admin/overview")
async def get_admin_overview(request: Request):
    """Return both system metrics and registered inspectors in a single fast call."""
    admin_user = get_current_user_from_req(request)
    if not admin_user or admin_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required.")

    users = list_all_users()
    reports = list_reports_from_db(is_admin=True) or []

    inspectors = [u for u in users if u.get("role") != "admin"]
    total_inspectors = len(inspectors)
    verified_inspectors = sum(1 for u in inspectors if u.get("isVerified"))
    total_reports = len(reports)
    total_defects = sum(r.get("defects", 0) for r in reports)
    total_hazards = sum(r.get("hazards", 0) for r in reports)
    total_photos = sum(r.get("photoCount", 0) for r in reports)

    return {
        "success": True,
        "metrics": {
            "totalUsers": total_inspectors,
            "verifiedUsers": verified_inspectors,
            "totalReports": total_reports,
            "totalDefects": total_defects,
            "totalHazards": total_hazards,
            "totalPhotos": total_photos
        },
        "users": users
    }


@app.get("/api/admin/metrics")
async def get_admin_metrics(request: Request):
    """Get high-level system metrics (Admin only)."""
    admin_user = get_current_user_from_req(request)
    if not admin_user or admin_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required.")

    users = list_all_users()
    reports = list_reports_from_db(is_admin=True) or []

    # Accurate real inspector metrics (excluding admin from inspector count)
    inspectors = [u for u in users if u.get("role") != "admin"]
    total_inspectors = len(inspectors)
    verified_inspectors = sum(1 for u in inspectors if u.get("isVerified"))
    total_reports = len(reports)
    total_defects = sum(r.get("defects", 0) for r in reports)
    total_hazards = sum(r.get("hazards", 0) for r in reports)
    total_photos = sum(r.get("photoCount", 0) for r in reports)

    return {
        "success": True,
        "metrics": {
            "totalUsers": total_inspectors,
            "verifiedUsers": verified_inspectors,
            "totalReports": total_reports,
            "totalDefects": total_defects,
            "totalHazards": total_hazards,
            "totalPhotos": total_photos
        }
    }


@app.get("/api/admin/users")
async def get_admin_users(request: Request):
    """List all registered users and their statistics (Admin only)."""
    admin_user = get_current_user_from_req(request)
    if not admin_user or admin_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required.")

    users = list_all_users()
    return {
        "success": True,
        "users": users
    }


@app.delete("/api/admin/users/{target_user_id}")
async def delete_admin_user(target_user_id: str, request: Request):
    """Delete a user account (Admin only; cannot delete administrator)."""
    admin_user = get_current_user_from_req(request)
    if not admin_user or admin_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required.")

    target = get_user_by_id(target_user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    if target.get("role") == "admin":
        raise HTTPException(status_code=400, detail="Cannot delete administrator account.")

    conn = get_connection()
    if conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM saved_reports WHERE user_id = %s;", (target_user_id,))
            cur.execute("DELETE FROM email_otps WHERE LOWER(email) = %s;", (target["email"].lower(),))
            cur.execute("DELETE FROM users WHERE id = %s;", (target_user_id,))
            conn.commit()
        conn.close()

    return {"success": True, "message": f"User {target['email']} deleted successfully."}


@app.post("/api/admin/users/{target_user_id}/toggle-status")
async def toggle_admin_user_status(target_user_id: str, request: Request):
    """Toggle an inspector's account active/deactivated status (Admin only)."""
    admin_user = get_current_user_from_req(request)
    if not admin_user or admin_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required.")

    target = get_user_by_id(target_user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")

    if target.get("role") == "admin":
        raise HTTPException(status_code=400, detail="Cannot deactivate administrator account.")

    current_active = bool(target.get("is_active", True) if target.get("is_active") is not None else target.get("isActive", True))
    new_active = not current_active

    success = update_user_active_status(target_user_id, new_active)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to update user active status in database.")

    status_str = "activated" if new_active else "deactivated"
    return {
        "success": True,
        "isActive": new_active,
        "is_active": new_active,
        "message": f"Inspector account '{target['email']}' has been {status_str} successfully."
    }


@app.get("/api/admin/users/{target_user_id}/reports")
async def get_admin_user_reports(target_user_id: str, request: Request):
    """List all inspection reports for a specific target user (Admin only)."""
    admin_user = get_current_user_from_req(request)
    if not admin_user or admin_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required.")

    target_user = get_user_by_id(target_user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="Target user not found.")

    reports = list_reports_from_db(is_admin=True, target_user_id=target_user_id) or []
    return {
        "success": True,
        "user": target_user,
        "reports": reports
    }


# ==============================================================================
# SAVED REPORTS SYSTEM (Neon PostgreSQL + User Scoped)
# ==============================================================================

@app.get("/api/reports")
async def list_saved_reports(request: Request):
    """List saved inspection reports scoped by the authenticated user."""
    user = get_current_user_from_req(request)
    is_admin = bool(user and user.get("role") == "admin")
    target_user = request.query_params.get("user_id") if is_admin else None

    user_id = user["id"] if user else None
    db_reports = list_reports_from_db(user_id=user_id, is_admin=is_admin, target_user_id=target_user)

    if db_reports is not None:
        return {
            "success": True,
            "storage": "Neon PostgreSQL",
            "reports": db_reports
        }

    return {
        "success": True,
        "storage": "Empty",
        "reports": []
    }


@app.post("/api/reports/save")
async def save_report(payload: InspectionPayload, request: Request):
    """Save an inspection report to Neon PostgreSQL database linked to the user."""
    try:
        user = get_current_user_from_req(request)
        user_id = user["id"] if user else None

        report_id = payload.id or f"rep_{uuid.uuid4().hex[:10]}"
        payload_dict = payload.dict()
        payload_dict['id'] = report_id
        payload_dict['userId'] = user_id
        payload_dict['savedAt'] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

        # 1. Save to Neon PostgreSQL
        saved_db = save_report_to_db(report_id, payload_dict, user_id=user_id)

        # 2. Local JSON backup
        try:
            json_path = os.path.join(saved_reports_path, f"{report_id}.json")
            with open(json_path, 'w', encoding='utf-8') as fp:
                json.dump(payload_dict, fp, indent=2)
        except Exception:
            pass

        return {
            "success": True,
            "id": report_id,
            "storage": "Neon PostgreSQL" if saved_db else "Local Backup",
            "message": "Report saved to database successfully."
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save report: {str(e)}")


@app.get("/api/reports/{report_id}")
async def get_saved_report(report_id: str, request: Request):
    """Load a specific saved report to continue editing."""
    user = get_current_user_from_req(request)
    is_admin = bool(user and user.get("role") == "admin")
    user_id = user["id"] if user else None

    # 1. Try PostgreSQL
    db_data = get_report_from_db(report_id, user_id=user_id, is_admin=is_admin)
    if db_data:
        return {"success": True, "data": db_data}

    # 2. Try local fallback
    json_path = os.path.join(saved_reports_path, f"{report_id}.json")
    if os.path.exists(json_path):
        with open(json_path, 'r', encoding='utf-8') as fp:
            data = json.load(fp)
        return {"success": True, "data": data}

    raise HTTPException(status_code=404, detail="Report not found.")


@app.delete("/api/reports/{report_id}")
async def delete_saved_report(report_id: str, request: Request):
    """Delete a saved report from PostgreSQL and local storage."""
    user = get_current_user_from_req(request)
    is_admin = bool(user and user.get("role") == "admin")
    user_id = user["id"] if user else None

    deleted_db = delete_report_from_db(report_id, user_id=user_id, is_admin=is_admin)
    json_path = os.path.join(saved_reports_path, f"{report_id}.json")
    if os.path.exists(json_path):
        os.remove(json_path)

    return {"success": True, "message": "Report deleted from database."}


# ==============================================================================
# EXPORT ENDPOINTS (.HZF and .BIN)
# ==============================================================================

@app.post("/api/export-hzf")
async def export_hzf(payload: InspectionPayload):
    """Package inspection data into a valid .hzf file."""
    try:
        hzf_bytes = build_hzf_bytes(payload.dict())
        filename = payload.fileName
        if not filename.lower().endswith('.hzf'):
            filename = os.path.splitext(filename)[0] + '.hzf'

        return Response(
            content=hzf_bytes,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate .hzf: {str(e)}")

@app.post("/api/export-bin")
async def export_bin(payload: InspectionPayload):
    """Package inspection data into a valid .bin mobile container."""
    try:
        bin_bytes = build_hzf_bytes(payload.dict())
        filename = payload.fileName
        if not filename.lower().endswith('.bin'):
            filename = os.path.splitext(filename)[0] + '.bin'

        return Response(
            content=bin_bytes,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate .bin: {str(e)}")

@app.post("/api/export-pdf")
async def export_pdf(payload: ExportPdfPayload):
    """Package inspection data into a visual PDF report matching HIP standard."""
    try:
        pdf_bytes = generate_hip_inspection_pdf(
            inspection_data=payload.dict(),
            custom_cover_image=payload.coverPhoto,
            custom_inspector_info=payload.inspectorInfo
        )
        filename = payload.fileName
        if not filename.lower().endswith('.pdf'):
            filename = os.path.splitext(filename)[0] + '.pdf'

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="{filename}"'}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate PDF: {str(e)}")

# ==============================================================================
# AUTOMATED AI & QA REVIEW ENDPOINTS
# ==============================================================================

@app.get("/api/ai/status")
async def get_ai_status():
    """Check if Gemini AI API is configured and operational."""
    return await test_gemini_connection()

@app.post("/api/ai/set-key")
async def update_ai_key(payload: SetApiKeyPayload):
    """Dynamically set or update Gemini API key in .env and runtime."""
    key = payload.apiKey.strip()
    model = payload.model or os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    
    os.environ["GEMINI_API_KEY"] = key
    os.environ["GEMINI_MODEL"] = model

    # Persist to backend/.env
    env_file = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_file):
        try:
            with open(env_file, "r", encoding="utf-8") as f:
                lines = f.readlines()
            new_lines = []
            found_key = False
            found_model = False
            for line in lines:
                if line.startswith("GEMINI_API_KEY="):
                    new_lines.append(f"GEMINI_API_KEY={key}\n")
                    found_key = True
                elif line.startswith("GEMINI_MODEL="):
                    new_lines.append(f"GEMINI_MODEL={model}\n")
                    found_model = True
                else:
                    new_lines.append(line)
            if not found_key:
                new_lines.append(f"GEMINI_API_KEY={key}\n")
            if not found_model:
                new_lines.append(f"GEMINI_MODEL={model}\n")
            with open(env_file, "w", encoding="utf-8") as f:
                f.writelines(new_lines)
        except Exception as e:
            print("Failed to persist key to .env:", e)

    return await test_gemini_connection()

@app.post("/api/ai/polish-item")
async def api_polish_item(payload: PolishItemPayload):
    """Polish a single item's field notes or inspect attached photos using Gemini Vision."""
    res = await polish_single_item(
        section_name=payload.sectionName,
        item_name=payload.itemName,
        status=payload.status,
        raw_comments=payload.rawComments or "",
        photos_count=payload.photosCount or len(payload.photos or []),
        photos=payload.photos or []
    )
    return res

@app.post("/api/ai/batch-polish")
async def api_batch_polish(payload: InspectionPayload):
    """Run automated narrative enhancement across all defective items in the report."""
    res = await batch_polish_inspection(payload.dict())
    return res

@app.post("/api/ai/summary")
async def api_executive_summary(payload: InspectionPayload):
    """Generate structured executive summary and contractor recommendations."""
    res = await generate_executive_summary(payload.dict())
    return res

@app.post("/api/qa/audit")
async def api_qa_audit(payload: InspectionPayload):
    """Perform rule-based QA audit for missing photos, omitted sections, and metadata."""
    res = audit_inspection(payload.dict())
    return res

# ==============================================================================
# ROOT HEALTH & API STATUS (Pure REST Backend)
# ==============================================================================

@app.api_route("/", methods=["GET", "HEAD"])
async def root_status():
    """Return pure backend API status and documentation links."""
    return {
        "status": "online",
        "service": APP_NAME,
        "version": APP_VERSION,
        "environment": APP_ENV,
        "database": "Neon PostgreSQL (Connected)" if os.getenv("DATABASE_URL") else "Local Storage",
        "docs": "/docs",
        "health": "/api/health",
        "config": "/api/config"
    }

@app.api_route("/favicon.ico", methods=["GET", "HEAD"])
async def favicon():
    return Response(status_code=204)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)



