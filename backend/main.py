"""
HZF & BIN Inspector Studio - FastAPI Backend Server
Loads configuration from .env, manages saved reports in Neon PostgreSQL,
parses .hzf/.bin files, and packages inspections into .hzf, .bin, and PDF.
"""

import os
import json
import uuid
import datetime
from fastapi import FastAPI, UploadFile, File, Response, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Dict, Any, List, Optional
from dotenv import load_dotenv

from hzf_parser import parse_hzf_bytes, build_hzf_bytes, get_clean_blank_template
from db import init_db, save_report_to_db, list_reports_from_db, get_report_from_db, delete_report_from_db
from ai_service import (
    is_ai_configured,
    test_gemini_connection,
    polish_single_item,
    batch_polish_inspection,
    generate_executive_summary
)
from qa_validator import audit_inspection

# Load environment configuration
load_dotenv()

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
SAVED_DIR = os.getenv("SAVED_REPORTS_DIR", "saved_reports")

# Ensure local backup directory exists
saved_reports_path = os.path.join(os.path.dirname(__file__), SAVED_DIR)
os.makedirs(saved_reports_path, exist_ok=True)

# Initialize PostgreSQL database
init_db()

app = FastAPI(
    title="HZF & BIN Inspector Studio API",
    description="Backend services with Neon PostgreSQL for storing and generating .hzf/.bin inspections",
    version="2.3.0"
)

# CORS Setup for Vercel / Cloud Deployments
cors_origins_env = os.getenv("CORS_ORIGINS", "*")
if cors_origins_env == "*":
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
        allow_origins=[o.strip() for o in cors_origins_env.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

class InspectionPayload(BaseModel):
    id: Optional[str] = None
    fileName: str = "Inspection_Report.hzf"
    clientInfo: Dict[str, Any] = {}
    sections: List[Dict[str, Any]] = []

class PolishItemPayload(BaseModel):
    sectionName: str
    itemName: str
    status: str
    rawComments: Optional[str] = ""
    photosCount: Optional[int] = 0
    photos: Optional[List[Dict[str, Any]]] = []

class SetApiKeyPayload(BaseModel):
    apiKey: str
    model: Optional[str] = "gemini-3-flash-preview"

@app.get("/api/health")
async def health_check():
    db_reports = list_reports_from_db()
    db_count = len(db_reports) if db_reports is not None else 0
    return {
        "status": "online",
        "app": "HZF & BIN Inspector Studio",
        "database": "Neon PostgreSQL (Connected)",
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
# SAVED REPORTS SYSTEM (Neon PostgreSQL + Local Fallback)
# ==============================================================================

@app.get("/api/reports")
async def list_saved_reports():
    """List all saved inspection reports with summary metadata from PostgreSQL."""
    db_reports = list_reports_from_db()
    if db_reports is not None:
        return {
            "success": True,
            "storage": "Neon PostgreSQL",
            "reports": db_reports
        }

    # Fallback to local files if database disconnected
    reports = []
    for f in os.listdir(saved_reports_path):
        if f.endswith('.json'):
            fpath = os.path.join(saved_reports_path, f)
            try:
                with open(fpath, 'r', encoding='utf-8') as fp:
                    data = json.load(fp)

                c = data.get('clientInfo', {})
                sections = data.get('sections', [])
                
                total_items = sum(len(s.get('items', [])) for s in sections)
                defects = sum(1 for s in sections for it in s.get('items', []) if it.get('status') == 'Defective')
                hazards = sum(1 for s in sections for it in s.get('items', []) if it.get('status') == 'Safety Hazard')
                photos = sum(len(it.get('photos', [])) for s in sections for it in s.get('items', []))

                reports.append({
                    "id": data.get('id') or f.replace('.json', ''),
                    "fileName": data.get('fileName', 'Report.hzf'),
                    "clientName": c.get('clientName') or "Untitled Client",
                    "address": c.get('inspectionAddress') or "No Address Specified",
                    "inspectionDate": c.get('inspectionDate') or "",
                    "savedAt": data.get('savedAt') or "",
                    "totalItems": total_items,
                    "defects": defects,
                    "hazards": hazards,
                    "photoCount": photos
                })
            except Exception:
                pass

    reports.sort(key=lambda r: r.get('savedAt', ''), reverse=True)
    return {
        "success": True,
        "storage": "Local JSON",
        "reports": reports
    }

@app.post("/api/reports/save")
async def save_report(payload: InspectionPayload):
    """Save an inspection report to Neon PostgreSQL database and local backup."""
    try:
        report_id = payload.id or f"rep_{uuid.uuid4().hex[:10]}"
        payload_dict = payload.dict()
        payload_dict['id'] = report_id
        payload_dict['savedAt'] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

        # 1. Save to Neon PostgreSQL
        saved_db = save_report_to_db(report_id, payload_dict)

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
async def get_saved_report(report_id: str):
    """Load a specific saved report to continue editing."""
    # 1. Try PostgreSQL
    db_data = get_report_from_db(report_id)
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
async def delete_saved_report(report_id: str):
    """Delete a saved report from PostgreSQL and local storage."""
    deleted_db = delete_report_from_db(report_id)
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
    model = payload.model or "gemini-3-flash-preview"
    
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

# Mount frontend directory
frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
