"""
Neon PostgreSQL Database Module for HZF Inspector Studio
Handles persistent storage of users, email OTPs, and inspection reports in PostgreSQL.
"""

import os
import json
import uuid
import datetime
import psycopg2
import psycopg2.extras
from typing import Dict, Any, List, Optional
from dotenv import load_dotenv

from auth import hash_password, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, ADMIN_PHONE, ADMIN_ORG

backend_env = os.path.join(os.path.dirname(__file__), ".env")
root_env = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(backend_env, override=True)
load_dotenv(root_env, override=False)

DATABASE_URL = os.getenv("DATABASE_URL")


def get_connection():
    """Return a psycopg2 connection if DATABASE_URL is configured."""
    if not DATABASE_URL:
        return None
    return psycopg2.connect(DATABASE_URL)


def init_db():
    """Initialize PostgreSQL tables, schema migrations, and default admin seed."""
    if not DATABASE_URL:
        print("[DB Warning] DATABASE_URL not set. Running with fallback storage.")
        return False

    try:
        conn = get_connection()
        with conn.cursor() as cur:
            # 1. Users table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id VARCHAR(64) PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    email VARCHAR(255) UNIQUE NOT NULL,
                    phone VARCHAR(64),
                    organization VARCHAR(255),
                    password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(32) DEFAULT 'user',
                    is_verified BOOLEAN DEFAULT FALSE,
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    last_login TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            """)

            # Ensure is_active column exists if table was created previously
            cur.execute("""
                ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
            """)

            # 2. Email OTPs table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS email_otps (
                    id SERIAL PRIMARY KEY,
                    email VARCHAR(255) NOT NULL,
                    otp_code VARCHAR(16) NOT NULL,
                    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps(email);
            """)

            # 3. Saved Reports table with user_id
            cur.execute("""
                CREATE TABLE IF NOT EXISTS saved_reports (
                    id VARCHAR(64) PRIMARY KEY,
                    user_id VARCHAR(64),
                    filename VARCHAR(255) NOT NULL,
                    client_name VARCHAR(255),
                    property_address TEXT,
                    inspector_name VARCHAR(255),
                    inspection_date VARCHAR(64),
                    report_data JSONB NOT NULL,
                    total_items INT DEFAULT 0,
                    defects_count INT DEFAULT 0,
                    hazards_count INT DEFAULT 0,
                    photos_count INT DEFAULT 0,
                    saved_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            """)

            # Ensure user_id column exists if table was created previously
            cur.execute("""
                ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
                CREATE INDEX IF NOT EXISTS idx_saved_reports_user ON saved_reports(user_id);
            """)

            # 4. Clean up any stale unlinked reports as requested ("delete all")
            cur.execute("""
                DELETE FROM saved_reports WHERE user_id IS NULL OR user_id = '';
            """)

            # 5. Seed or Update Default Admin
            cur.execute("SELECT id, password_hash, role FROM users WHERE LOWER(email) = %s;", (ADMIN_EMAIL,))
            admin_row = cur.fetchone()
            if not admin_row:
                admin_id = f"usr_{uuid.uuid4().hex[:12]}"
                hashed_pw = hash_password(ADMIN_PASSWORD)
                cur.execute("""
                    INSERT INTO users (id, name, email, phone, organization, password_hash, role, is_verified)
                    VALUES (%s, %s, %s, %s, %s, %s, 'admin', TRUE);
                """, (admin_id, ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE, ADMIN_ORG, hashed_pw))
                print(f"[DB Seed] Default Admin user created: {ADMIN_EMAIL}")
            else:
                # Ensure existing admin email is marked as admin and verified
                cur.execute("""
                    UPDATE users SET role = 'admin', is_verified = TRUE WHERE LOWER(email) = %s;
                """, (ADMIN_EMAIL,))

            conn.commit()
        conn.close()
        print("[DB] PostgreSQL tables 'users', 'email_otps', and 'saved_reports' verified successfully.")
        return True
    except Exception as e:
        print("[DB Init Warning]", e)
        return False


# ==============================================================================
# USER MANAGEMENT FUNCTIONS
# ==============================================================================

def create_user(name: str, email: str, phone: str, organization: str, password_hash: str, role: str = 'user', is_verified: bool = False) -> Optional[Dict[str, Any]]:
    """Create a new user record in PostgreSQL."""
    conn = get_connection()
    if not conn:
        return None

    user_id = f"usr_{uuid.uuid4().hex[:12]}"
    clean_email = email.lower().strip()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO users (id, name, email, phone, organization, password_hash, role, is_verified)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, name, email, phone, organization, role, is_verified, created_at;
            """, (user_id, name.strip(), clean_email, phone.strip(), organization.strip(), password_hash, role, is_verified))
            user = dict(cur.fetchone())
            conn.commit()
        conn.close()
        return user
    except Exception as e:
        print(f"[DB Error] Error creating user: {e}")
        conn.close()
        return None


def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    """Retrieve full user profile by email."""
    conn = get_connection()
    if not conn:
        return None

    clean_email = email.lower().strip()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, name, email, phone, organization, password_hash, role, is_verified,
                       COALESCE(is_active, TRUE) as "isActive",
                       COALESCE(is_active, TRUE) as is_active,
                       to_char(created_at, 'YYYY-MM-DD HH24:MI') as "createdAt",
                       to_char(last_login, 'YYYY-MM-DD HH24:MI') as "lastLogin"
                FROM users
                WHERE LOWER(email) = %s;
            """, (clean_email,))
            row = cur.fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception as e:
        print(f"[DB Error] Error getting user by email: {e}")
        conn.close()
        return None


def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve user profile by ID."""
    conn = get_connection()
    if not conn:
        return None

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, name, email, phone, organization, role, is_verified,
                       COALESCE(is_active, TRUE) as "isActive",
                       COALESCE(is_active, TRUE) as is_active,
                       to_char(created_at, 'YYYY-MM-DD HH24:MI') as "createdAt",
                       to_char(last_login, 'YYYY-MM-DD HH24:MI') as "lastLogin"
                FROM users
                WHERE id = %s;
            """, (user_id,))
            row = cur.fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception as e:
        print(f"[DB Error] Error getting user by ID: {e}")
        conn.close()
        return None


def update_user_verified(email: str) -> bool:
    """Mark a user as verified."""
    conn = get_connection()
    if not conn:
        return False

    clean_email = email.lower().strip()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET is_verified = TRUE WHERE LOWER(email) = %s;
            """, (clean_email,))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"[DB Error] Error marking user verified: {e}")
        conn.close()
        return False


def update_user_password(email: str, password_hash: str) -> bool:
    """Update password hash for a user."""
    conn = get_connection()
    if not conn:
        return False

    clean_email = email.lower().strip()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET password_hash = %s WHERE LOWER(email) = %s;
            """, (password_hash, clean_email))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"[DB Error] Error updating user password: {e}")
        conn.close()
        return False


def update_user_last_login(user_id: str) -> bool:
    """Update last login timestamp for a user."""
    conn = get_connection()
    if not conn:
        return False

    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = %s;
            """, (user_id,))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        conn.close()
        return False


def list_all_users() -> List[Dict[str, Any]]:
    """List all registered users along with their activity metrics (Admin only)."""
    conn = get_connection()
    if not conn:
        return []

    try:
        users = []
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT 
                    u.id, 
                    u.name, 
                    u.email, 
                    u.phone, 
                    u.organization, 
                    u.role, 
                    u.is_verified as "isVerified",
                    COALESCE(u.is_active, TRUE) as "isActive",
                    COALESCE(u.is_active, TRUE) as is_active,
                    to_char(u.created_at, 'YYYY-MM-DD HH24:MI') as "createdAt",
                    to_char(u.last_login, 'YYYY-MM-DD HH24:MI') as "lastLogin",
                    COUNT(r.id) as "reportsCount",
                    COALESCE(SUM(r.total_items), 0) as "totalItems",
                    COALESCE(SUM(r.defects_count), 0) as "totalDefects",
                    COALESCE(SUM(r.hazards_count), 0) as "totalHazards",
                    COALESCE(SUM(r.photos_count), 0) as "totalPhotos"
                FROM users u
                LEFT JOIN saved_reports r ON u.id = r.user_id
                GROUP BY u.id, u.name, u.email, u.phone, u.organization, u.role, u.is_verified, u.is_active, u.created_at, u.last_login
                ORDER BY u.created_at DESC;
            """)
            rows = cur.fetchall()
            for r in rows:
                users.append(dict(r))
        conn.close()
        return users
    except Exception as e:
        print(f"[DB Error] Error listing users: {e}")
        conn.close()
        return []


def update_user_active_status(user_id: str, is_active: bool) -> bool:
    """Activate or deactivate an inspector account (Admin only)."""
    conn = get_connection()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET is_active = %s WHERE id = %s;
            """, (is_active, user_id))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"[DB Error] Error updating user active status: {e}")
        conn.close()
        return False


# ==============================================================================
# OTP MANAGEMENT FUNCTIONS
# ==============================================================================

def save_otp(email: str, otp_code: str, minutes: int = 10) -> bool:
    """Save an OTP for email verification with expiration."""
    conn = get_connection()
    if not conn:
        return False

    clean_email = email.lower().strip()
    expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=minutes)
    try:
        with conn.cursor() as cur:
            # Invalidate older OTPs for this email
            cur.execute("DELETE FROM email_otps WHERE LOWER(email) = %s;", (clean_email,))
            # Insert new OTP
            cur.execute("""
                INSERT INTO email_otps (email, otp_code, expires_at)
                VALUES (%s, %s, %s);
            """, (clean_email, otp_code, expires_at))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"[DB Error] Error saving OTP: {e}")
        conn.close()
        return False


def verify_otp_in_db(email: str, otp_code: str) -> bool:
    """Verify OTP against database records."""
    conn = get_connection()
    if not conn:
        return False

    clean_email = email.lower().strip()
    clean_otp = str(otp_code).strip()
    try:
        now = datetime.datetime.now(datetime.timezone.utc)
        verified = False
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id FROM email_otps
                WHERE LOWER(email) = %s AND otp_code = %s AND expires_at > %s;
            """, (clean_email, clean_otp, now))
            row = cur.fetchone()
            if row:
                verified = True
                # Delete consumed OTP
                cur.execute("DELETE FROM email_otps WHERE LOWER(email) = %s;", (clean_email,))
                conn.commit()
        conn.close()
        return verified
    except Exception as e:
        print(f"[DB Error] Error verifying OTP: {e}")
        conn.close()
        return False


# ==============================================================================
# REPORT MANAGEMENT FUNCTIONS (Scoped by user_id)
# ==============================================================================

def save_report_to_db(report_id: str, payload_dict: Dict[str, Any], user_id: Optional[str] = None) -> bool:
    """Save or update an inspection report in PostgreSQL with user association."""
    conn = get_connection()
    if not conn:
        return False

    try:
        filename = payload_dict.get('fileName', 'Report.hzf')
        c = payload_dict.get('clientInfo', {})
        client_name = c.get('clientName', '')
        property_address = c.get('inspectionAddress', '')
        inspector_name = c.get('inspectorName', '')
        inspection_date = c.get('inspectionDate', '')

        total_items = 0
        defects = 0
        hazards = 0
        photos = 0

        for s in payload_dict.get('sections', []):
            for it in s.get('items', []):
                total_items += 1
                st = it.get('status', '')
                if st == 'Safety Hazard': hazards += 1
                elif st == 'Defective': defects += 1
                photos += len(it.get('photos', []))

        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO saved_reports (
                    id, user_id, filename, client_name, property_address, inspector_name,
                    inspection_date, report_data, total_items, defects_count,
                    hazards_count, photos_count, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE SET
                    user_id = COALESCE(EXCLUDED.user_id, saved_reports.user_id),
                    filename = EXCLUDED.filename,
                    client_name = EXCLUDED.client_name,
                    property_address = EXCLUDED.property_address,
                    inspector_name = EXCLUDED.inspector_name,
                    inspection_date = EXCLUDED.inspection_date,
                    report_data = EXCLUDED.report_data,
                    total_items = EXCLUDED.total_items,
                    defects_count = EXCLUDED.defects_count,
                    hazards_count = EXCLUDED.hazards_count,
                    photos_count = EXCLUDED.photos_count,
                    updated_at = CURRENT_TIMESTAMP;
            """, (
                report_id, user_id, filename, client_name, property_address, inspector_name,
                inspection_date, json.dumps(payload_dict), total_items, defects,
                hazards, photos
            ))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        print("[DB Error] Error saving to PostgreSQL:", e)
        conn.close()
        return False


def list_reports_from_db(user_id: Optional[str] = None, is_admin: bool = False, target_user_id: Optional[str] = None) -> Optional[List[Dict[str, Any]]]:
    """
    Fetch saved reports summary.
    If is_admin and target_user_id is provided, filters for that specific user.
    If is_admin and no target_user_id, fetches all reports.
    If regular user, strictly filters by user_id.
    """
    conn = get_connection()
    if not conn:
        return None

    try:
        reports = []
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            query = """
                SELECT 
                    r.id, 
                    r.user_id as "userId",
                    u.name as "userName",
                    u.email as "userEmail",
                    r.filename as "fileName", 
                    r.client_name as "clientName",
                    r.property_address as "address", 
                    r.inspection_date as "inspectionDate",
                    r.total_items as "totalItems", 
                    r.defects_count as "defects",
                    r.hazards_count as "hazards", 
                    r.photos_count as "photoCount",
                    to_char(r.updated_at, 'YYYY-MM-DD HH24:MI') as "savedAt"
                FROM saved_reports r
                LEFT JOIN users u ON r.user_id = u.id
            """
            params = []
            if is_admin and target_user_id:
                query += " WHERE r.user_id = %s"
                params.append(target_user_id)
            elif not is_admin:
                query += " WHERE r.user_id = %s"
                params.append(user_id)

            query += " ORDER BY r.updated_at DESC;"

            cur.execute(query, tuple(params))
            rows = cur.fetchall()
            for r in rows:
                reports.append(dict(r))
        conn.close()
        return reports
    except Exception as e:
        print("[DB Error] Error listing from PostgreSQL:", e)
        conn.close()
        return None


def get_report_from_db(report_id: str, user_id: Optional[str] = None, is_admin: bool = False) -> Optional[Dict[str, Any]]:
    """Retrieve full report data by ID. Regular users can only fetch their own."""
    conn = get_connection()
    if not conn:
        return None

    try:
        report_data = None
        with conn.cursor() as cur:
            if is_admin:
                cur.execute("SELECT report_data FROM saved_reports WHERE id = %s;", (report_id,))
            else:
                cur.execute("SELECT report_data FROM saved_reports WHERE id = %s AND user_id = %s;", (report_id, user_id))
            row = cur.fetchone()
            if row:
                report_data = row[0]
                if isinstance(report_data, str):
                    report_data = json.loads(report_data)
        conn.close()
        return report_data
    except Exception as e:
        print("[DB Error] Error fetching from PostgreSQL:", e)
        conn.close()
        return None


def delete_report_from_db(report_id: str, user_id: Optional[str] = None, is_admin: bool = False) -> bool:
    """Delete a report by ID. Regular users can only delete their own reports."""
    conn = get_connection()
    if not conn:
        return False

    try:
        with conn.cursor() as cur:
            if is_admin:
                cur.execute("DELETE FROM saved_reports WHERE id = %s;", (report_id,))
            else:
                cur.execute("DELETE FROM saved_reports WHERE id = %s AND user_id = %s;", (report_id, user_id))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        print("[DB Error] Error deleting from PostgreSQL:", e)
        conn.close()
        return False
