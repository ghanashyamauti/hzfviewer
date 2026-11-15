"""
Authentication, Token Management, and SMTP OTP Verification Service
for HZF Inspector Studio.
Uses pure Python standard libraries (hashlib, hmac, smtplib, secrets, base64, json).
"""

import os
import json
import time
import hmac
import hashlib
import secrets
import base64
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional, Dict, Any, Tuple
from dotenv import load_dotenv

backend_env = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(backend_env, override=True)

JWT_SECRET = os.getenv("JWT_SECRET", "hzf_inspector_studio_super_secret_jwt_key_2026_x99")
JWT_ALGORITHM = "HS256"
# 10 years expiration in seconds (persistent login unless user logs out manually)
SESSION_EXPIRATION_SECONDS = 3600 * 24 * 365 * 10

# SMTP Configuration
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "").strip().replace(" ", "")
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", "").strip() or SMTP_USER
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "Home Inspector Pro Studio").strip()

# Admin Credentials
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@hzfstudio.com").lower().strip()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Admin@12345")
ADMIN_NAME = os.getenv("ADMIN_NAME", "System Administrator")
ADMIN_PHONE = os.getenv("ADMIN_PHONE", "9999999999")
ADMIN_ORG = os.getenv("ADMIN_ORG", "HZF Studio Headquarters")


# ==============================================================================
# PASSWORD HASHING (PBKDF2-HMAC-SHA256)
# ==============================================================================

def hash_password(password: str) -> str:
    """Hash password with a unique cryptographic salt."""
    salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        salt.encode('utf-8'),
        100000
    )
    return f"{salt}${key.hex()}"


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify plain password against stored salt$hash."""
    if not hashed_password or '$' not in hashed_password:
        return False
    try:
        salt, expected_hex = hashed_password.split('$', 1)
        actual_key = hashlib.pbkdf2_hmac(
            'sha256',
            plain_password.encode('utf-8'),
            salt.encode('utf-8'),
            100000
        )
        return hmac.compare_digest(actual_key.hex(), expected_hex)
    except Exception:
        return False


# ==============================================================================
# JWT TOKEN GENERATION & DECODING (Pure Python HS256)
# ==============================================================================

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('utf-8').rstrip('=')


def _b64url_decode(data: str) -> bytes:
    padding = '=' * (4 - (len(data) % 4)) if (len(data) % 4) != 0 else ''
    return base64.urlsafe_b64decode(data + padding)


def create_access_token(user_id: str, email: str, role: str, name: str) -> str:
    """Generate a long-lived JWT token."""
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {
        "sub": user_id,
        "email": email.lower().strip(),
        "role": role,
        "name": name,
        "iat": now,
        "exp": now + SESSION_EXPIRATION_SECONDS
    }

    h_encoded = _b64url_encode(json.dumps(header, separators=(',', ':')).encode('utf-8'))
    p_encoded = _b64url_encode(json.dumps(payload, separators=(',', ':')).encode('utf-8'))
    msg = f"{h_encoded}.{p_encoded}".encode('utf-8')

    signature = hmac.new(JWT_SECRET.encode('utf-8'), msg, hashlib.sha256).digest()
    sig_encoded = _b64url_encode(signature)

    return f"{h_encoded}.{p_encoded}.{sig_encoded}"


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    """Verify and decode a JWT token. Returns payload dict or None if invalid/expired."""
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None

        h_encoded, p_encoded, sig_encoded = parts
        msg = f"{h_encoded}.{p_encoded}".encode('utf-8')
        expected_sig = hmac.new(JWT_SECRET.encode('utf-8'), msg, hashlib.sha256).digest()

        actual_sig = _b64url_decode(sig_encoded)
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None

        payload_bytes = _b64url_decode(p_encoded)
        payload = json.loads(payload_bytes.decode('utf-8'))

        # Check expiration
        now = int(time.time())
        if payload.get("exp") and payload["exp"] < now:
            return None

        return payload
    except Exception:
        return None


# ==============================================================================
# OTP GENERATION & SMTP EMAIL DELIVERY
# ==============================================================================

def generate_otp() -> str:
    """Generate a secure 6-digit numeric OTP."""
    return f"{secrets.randbelow(900000) + 100000:06d}"


def send_otp_email(to_email: str, otp_code: str, user_name: str, purpose: str = "signup") -> Tuple[bool, str]:
    """
    Send OTP verification or password reset email via configured SMTP server.
    """
    if not SMTP_USER or not SMTP_PASSWORD:
        log_msg = (
            f"\n"
            f"==============================================================\n"
            f"[SMTP] Code for {to_email} ({user_name}) [{purpose.upper()}]:\n"
            f">>>  OTP CODE: {otp_code}  <<<\n"
            f"==============================================================\n"
        )
        print(log_msg)
        return True, "DEV_LOGGED"

    try:
        is_reset = (purpose.lower() == "reset")
        subject = f"{otp_code} is your Password Reset Code - Home Inspector Pro Studio" if is_reset else f"{otp_code} is your Verification Code - Home Inspector Pro Studio"
        headline = "Password Reset Request" if is_reset else "Verify Your Email Address"
        instruction = "We received a request to reset your password. Enter this code to set a new password:" if is_reset else "Thank you for creating an account with Home Inspector Pro Studio. Please enter this verification code to activate your account:"

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM_EMAIL}>"
        msg["To"] = to_email

        text_content = (
            f"Hello {user_name},\n\n"
            f"{instruction}\n\n"
            f"OTP CODE: {otp_code}\n\n"
            f"This code will expire in 10 minutes. If you did not make this request, please disregard this email.\n\n"
            f"Regards,\nHome Inspector Pro Studio Team"
        )

        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; }}
            .card {{ max-width: 500px; margin: 0 auto; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); overflow: hidden; }}
            .header {{ background: linear-gradient(180deg, #0a246a 0%, #003366 100%); color: #ffffff; padding: 22px 24px; text-align: center; }}
            .badge {{ display: inline-block; background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.35); color: #ffffff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }}
            .header h1 {{ margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }}
            .body {{ padding: 28px 26px; color: #1e293b; line-height: 1.55; font-size: 14px; }}
            .greeting {{ font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #003366; }}
            .otp-wrap {{ background: #f8fafc; border: 2px dashed #0055ea; border-radius: 8px; text-align: center; padding: 18px; margin: 22px 0; }}
            .otp-label {{ font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }}
            .otp-num {{ font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #003366; font-family: Consolas, 'Courier New', monospace; }}
            .expiry-note {{ font-size: 12px; color: #64748b; background: #f1f5f9; padding: 8px 12px; border-radius: 4px; border-left: 3px solid #0055ea; margin-top: 18px; }}
            .footer {{ background: #f8fafc; padding: 14px 24px; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; text-align: center; }}
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <div class="badge">HOME INSPECTOR PRO STUDIO</div>
              <h1>{headline}</h1>
            </div>
            <div class="body">
              <div class="greeting">Hello {user_name},</div>
              <p>{instruction}</p>
              <div class="otp-wrap">
                <div class="otp-label">6-Digit Verification Code</div>
                <div class="otp-num">{otp_code}</div>
              </div>
              <div class="expiry-note">
                ⏱️ This code expires in <strong>10 minutes</strong>. For your security, never share this code with anyone.
              </div>
            </div>
            <div class="footer">
              Home Inspector Pro Studio • Direct .hzf, .bin &amp; PDF Inspection Suite
            </div>
          </div>
        </body>
        </html>
        """

        msg.attach(MIMEText(text_content, "plain"))
        msg.attach(MIMEText(html_content, "html"))

        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.ehlo()
                server.starttls()
                server.ehlo()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)

        print(f"[SMTP] Successfully dispatched {purpose.upper()} code to {to_email}")
        return True, "SENT"
    except Exception as err:
        print(f"[SMTP Error] Failed to send email to {to_email}: {err}")
        return False, str(err)


def send_welcome_email(to_email: str, user_name: str) -> Tuple[bool, str]:
    """Send welcome confirmation email after successful verification."""
    if not SMTP_USER or not SMTP_PASSWORD:
        return True, "DEV_LOGGED"

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = "Welcome to Home Inspector Pro Studio - Account Activated"
        msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM_EMAIL}>"
        msg["To"] = to_email

        text_content = (
            f"Hello {user_name},\n\n"
            f"Congratulations! Your inspector account for {to_email} is activated.\n\n"
            f"You can now build, edit, and export .hzf, .bin, and PDF inspection reports.\n\n"
            f"Regards,\nHome Inspector Pro Studio Team"
        )

        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; }}
            .card {{ max-width: 500px; margin: 0 auto; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); overflow: hidden; }}
            .header {{ background: linear-gradient(180deg, #059669 0%, #047857 100%); color: #ffffff; padding: 24px; text-align: center; }}
            .header h1 {{ margin: 0; font-size: 20px; font-weight: 700; }}
            .body {{ padding: 28px 24px; color: #1e293b; line-height: 1.6; font-size: 14px; }}
            .feature-box {{ background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 16px; margin: 18px 0; }}
            .feature-item {{ margin: 6px 0; display: flex; align-items: center; gap: 8px; font-size: 13px; color: #334155; }}
            .footer {{ background: #f8fafc; padding: 14px 24px; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; text-align: center; }}
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <h1>🎉 Account Activated!</h1>
            </div>
            <div class="body">
              <p>Hello <strong>{user_name}</strong>,</p>
              <p>Welcome to <strong>Home Inspector Pro Studio</strong>! Your account for <strong>{to_email}</strong> has been successfully verified.</p>
              <div class="feature-box">
                <div style="font-weight: 700; margin-bottom: 8px; color: #003366;">You're ready to inspect:</div>
                <div class="feature-item">✓ Open &amp; Edit Native .hzf and .bin Inspection Reports</div>
                <div class="feature-item">✓ Real-time Vector PDF Generation with Cover Customization</div>
                <div class="feature-item">✓ AI-Powered Narrative Polishing &amp; QA Compliance Audit</div>
                <div class="feature-item">✓ Secure Cloud Storage with Persistent Sessions</div>
              </div>
              <p style="color: #64748b; font-size: 12px; margin-top: 16px;">You will remain signed in securely without auto-logout until you manually click Log Out.</p>
            </div>
            <div class="footer">
              Home Inspector Pro Studio • Professional Property Inspection Engineering
            </div>
          </div>
        </body>
        </html>
        """

        msg.attach(MIMEText(text_content, "plain"))
        msg.attach(MIMEText(html_content, "html"))

        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.ehlo()
                server.starttls()
                server.ehlo()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)

        print(f"[SMTP] Dispatched welcome email to {to_email}")
        return True, "SENT"
    except Exception as err:
        print(f"[SMTP Error] Failed to send welcome email to {to_email}: {err}")
        return False, str(err)
