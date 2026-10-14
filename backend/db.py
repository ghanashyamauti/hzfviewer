"""
Neon PostgreSQL Database Module for HZF Inspector Studio
Handles persistent storage of home inspection reports in PostgreSQL with JSON fallback.
"""

import os
import json
import psycopg2
import psycopg2.extras
from typing import Dict, Any, List, Optional
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

def get_connection():
    """Return a psycopg2 connection if DATABASE_URL is configured."""
    if not DATABASE_URL:
        return None
    return psycopg2.connect(DATABASE_URL)

def init_db():
    """Initialize PostgreSQL tables if not exists."""
    if not DATABASE_URL:
        print("DATABASE_URL not set. Running with local storage.")
        return False

    try:
        conn = get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS saved_reports (
                    id VARCHAR(64) PRIMARY KEY,
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
            conn.commit()
        conn.close()
        print("PostgreSQL table 'saved_reports' verified successfully.")
        return True
    except Exception as e:
        print("PostgreSQL init warning:", e)
        return False

def save_report_to_db(report_id: str, payload_dict: Dict[str, Any]) -> bool:
    """Save or update an inspection report in PostgreSQL."""
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
                    id, filename, client_name, property_address, inspector_name,
                    inspection_date, report_data, total_items, defects_count,
                    hazards_count, photos_count, updated_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE SET
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
                report_id, filename, client_name, property_address, inspector_name,
                inspection_date, json.dumps(payload_dict), total_items, defects,
                hazards, photos
            ))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        print("Error saving to PostgreSQL:", e)
        conn.close()
        return False

def list_reports_from_db() -> Optional[List[Dict[str, Any]]]:
    """Fetch all saved reports summary from PostgreSQL."""
    conn = get_connection()
    if not conn:
        return None

    try:
        reports = []
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT 
                    id, filename as "fileName", client_name as "clientName",
                    property_address as "address", inspection_date as "inspectionDate",
                    total_items as "totalItems", defects_count as "defects",
                    hazards_count as "hazards", photos_count as "photoCount",
                    to_char(updated_at, 'YYYY-MM-DD HH24:MI') as "savedAt"
                FROM saved_reports
                ORDER BY updated_at DESC;
            """)
            rows = cur.fetchall()
            for r in rows:
                reports.append(dict(r))
        conn.close()
        return reports
    except Exception as e:
        print("Error listing from PostgreSQL:", e)
        conn.close()
        return None

def get_report_from_db(report_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve full report data by ID from PostgreSQL."""
    conn = get_connection()
    if not conn:
        return None

    try:
        report_data = None
        with conn.cursor() as cur:
            cur.execute("SELECT report_data FROM saved_reports WHERE id = %s;", (report_id,))
            row = cur.fetchone()
            if row:
                report_data = row[0]
                if isinstance(report_data, str):
                    report_data = json.loads(report_data)
        conn.close()
        return report_data
    except Exception as e:
        print("Error fetching from PostgreSQL:", e)
        conn.close()
        return None

def delete_report_from_db(report_id: str) -> bool:
    """Delete a report by ID from PostgreSQL."""
    conn = get_connection()
    if not conn:
        return False

    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM saved_reports WHERE id = %s;", (report_id,))
            conn.commit()
        conn.close()
        return True
    except Exception as e:
        print("Error deleting from PostgreSQL:", e)
        conn.close()
        return False
