"""
Google Gemini AI Service for HZF Inspector Studio
Handles automated narrative polishing, defect severity recommendations,
and executive summary generation using the Google Gemini API.
"""

import os
import json
import logging
import asyncio
import httpx
from typing import Dict, Any, List, Optional, Tuple
from dotenv import load_dotenv

load_dotenv(override=True)

logger = logging.getLogger("ai_service")

def get_api_key() -> str:
    return os.getenv("GEMINI_API_KEY", "").strip()

def get_model() -> str:
    m = os.getenv("GEMINI_MODEL", "").strip()
    return m if m and m != "gemini-flash-latest" else "gemini-flash-lite-latest"

def is_ai_configured() -> bool:
    key = get_api_key()
    return bool(key and key != "your_gemini_api_key_here")

def get_gemini_url(model: Optional[str] = None) -> str:
    m = model or get_model()
    key = get_api_key()
    return f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={key}"

async def call_gemini_with_retry(payload: Dict[str, Any], max_retries: int = 3, timeout: float = 30.0) -> httpx.Response:
    """Helper to post to Gemini with automated model fallback and retry for 503 or 429 quota limits."""
    primary = get_model()
    fallback = "gemini-3-flash-preview" if primary != "gemini-3-flash-preview" else "gemini-flash-lite-latest"
    models_to_try = [primary, fallback]

    last_resp = None
    for model_name in models_to_try:
        url = get_gemini_url(model=model_name)
        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.post(url, json=payload)
                    last_resp = resp
                    if resp.status_code == 200:
                        return resp
                    elif resp.status_code == 429:
                        # Model quota exhausted, break inner loop to try fallback model
                        logger.warning(f"Quota exceeded (429) for {model_name}, trying fallback model...")
                        break
                    elif resp.status_code == 503 and attempt < max_retries - 1:
                        await asyncio.sleep(1.0 * (attempt + 1))
                        continue
                    else:
                        break
            except Exception as e:
                if attempt == max_retries - 1:
                    logger.warning(f"Exception calling {model_name}: {e}")
                await asyncio.sleep(1.0)
    return last_resp

SYSTEM_PROMPT = """You are a Master Home Inspector and Quality Assurance specialist certified by InterNACHI and ASHI.
Your job is to assist the in-house review team by expanding and refining rough, shorthand, or voice-to-text field notes taken on mobile devices into formal, legally sound, professional inspection report narratives.

STRICT GUIDELINES:
1. NEVER invent, hallucinate, or assume defects that the inspector did not mention.
2. Structure polished narratives with three clear components whenever a defect exists:
   - Observation: Exact factual finding (location, component, condition).
   - Implication: Potential consequence if left unaddressed (e.g. moisture intrusion, fire hazard, structural degradation).
   - Recommendation: Clear action with appropriate licensed trade (e.g. "Recommend evaluation and repair by a licensed electrical contractor").
3. Keep the tone objective, professional, and compliant with standard real estate home inspection report practices.
4. If an item is Satisfactory or has positive comments, keep it concise and professional.
"""

async def test_gemini_connection() -> Dict[str, Any]:
    """Test the Gemini API connection with the configured API key."""
    if not is_ai_configured():
        return {
            "success": False,
            "configured": False,
            "message": "GEMINI_API_KEY is not set in backend/.env. Please add your free Gemini API key."
        }

    url = get_gemini_url()
    payload = {
        "contents": [
            {
                "parts": [{"text": "Reply with 'OK' if you can read this."}]
            }
        ]
    }

    try:
        resp = await call_gemini_with_retry(payload, max_retries=2, timeout=10.0)
        if resp and resp.status_code == 200:
            data = resp.json()
            text = ""
            try:
                text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
            except Exception:
                pass
            return {
                "success": True,
                "configured": True,
                "model": os.getenv("GEMINI_MODEL") or "gemini-flash-latest",
                "response": text,
                "message": "Gemini API connection successful."
            }
        else:
            err_body = resp.text if resp else "No response"
            return {
                "success": False,
                "configured": True,
                "status_code": resp.status_code if resp else 500,
                "message": f"Gemini API returned error code {resp.status_code if resp else 500}: {err_body}"
            }
    except Exception as e:
        return {
            "success": False,
            "configured": True,
            "message": f"Failed to connect to Gemini API: {str(e)}"
        }

def extract_mime_and_base64(data_url: Any) -> Optional[Tuple[str, str]]:
    """Extracts MIME type and pure base64 string from data URL or raw string."""
    if not data_url or not isinstance(data_url, str):
        return None
    if "base64," in data_url:
        header, b64_str = data_url.split("base64,", 1)
        mime = "image/jpeg"
        if "data:" in header:
            mime = header.replace("data:", "").replace(";", "").strip() or "image/jpeg"
        if mime == "image/jpg":
            mime = "image/jpeg"
        b64_clean = b64_str.strip().replace("\n", "").replace("\r", "")
        if len(b64_clean) > 50:
            return mime, b64_clean
    return None

async def polish_single_item(
    section_name: str,
    item_name: str,
    status: str,
    raw_comments: Optional[str] = "",
    photos_count: int = 0,
    photos: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Polishes an inspection item's field notes or visually inspects attached photos
    using Google Gemini Vision to fill blank comment boxes.
    """
    if not is_ai_configured():
        return {
            "success": False,
            "error": "Gemini API key is not configured in backend/.env."
        }

    raw = (raw_comments or "").strip()
    valid_image_parts = []

    if photos:
        for p in photos[:3]:  # inspect up to 3 attached photos per item
            durl = p.get("dataUrl") or p.get("data")
            extracted = extract_mime_and_base64(durl)
            if extracted:
                mime, b64 = extracted
                valid_image_parts.append({
                    "inline_data": {
                        "mime_type": mime,
                        "data": b64
                    }
                })

    has_text = len(raw) >= 3
    has_images = len(valid_image_parts) > 0

    if not has_text and not has_images:
        return {
            "success": False,
            "error": "Please enter an inspector observation or attach at least one photo for AI to inspect."
        }

    if has_images and not has_text:
        # User uploaded photos but left note blank -> Gemini Vision inspects image and generates narrative
        prompt = f"""{SYSTEM_PROMPT}

You are an InterNACHI Master Home Inspector and QA specialist.
The inspector attached {len(valid_image_parts)} photo(s) of this inspection component, but the field observation note is currently blank.

Examine the attached photo(s) carefully:
- Section / Room: {section_name}
- Component / Item: {item_name}
- Current Inspector Status: {status}

INSTRUCTIONS:
1. Visually inspect the component in the photo(s). Identify what is shown, any visible defects, material issues, installation defects, damage, moisture signs, safety hazards, or if it appears functional.
2. Generate a formal, professional InterNACHI narrative following the three-part format:
   - Observation: Exact factual finding based on what is visible in the photo (location, component, observed condition).
   - Implication: Potential risk or consequence if left unaddressed (e.g. moisture intrusion, structural compromise, electrical fire hazard, safety risk).
   - Recommendation: Clear recommendation specifying the appropriate licensed trade (e.g. licensed electrician, licensed plumber, licensed roofing contractor).
3. Recommend the appropriate defect severity status: "Safety Hazard" | "Defective" | "Marginal" | "Satisfactory".
4. Recommend the contractor trade: "Plumbing" | "Electrical" | "HVAC" | "Roofing" | "Structural" | "General Contractor" | "Specialist".
5. Provide a 1-sentence executive summary bullet.
6. Provide a concise, descriptive caption for the primary photo.

Respond strictly with a valid JSON object with the following keys:
{{
  "polishedComments": "Formal expanded professional narrative following Observation, Implication, Recommendation.",
  "recommendedStatus": "Safety Hazard" | "Defective" | "Marginal" | "Satisfactory",
  "trade": "Plumbing" | "Electrical" | "HVAC" | "Roofing" | "Structural" | "General Contractor" | "Specialist",
  "summaryBullet": "A concise 1-sentence bullet summarizing the defect and required action for the client summary page.",
  "photoCaption": "Concise defect note for photo"
}}
Do NOT include markdown formatting or backticks around the JSON. Only return pure JSON.
"""
    elif has_images and has_text:
        # Both text field note and photos exist -> corroborate note with visual inspection
        prompt = f"""{SYSTEM_PROMPT}

You are an InterNACHI Master Home Inspector and QA specialist.
Inspect the following field note and the attached {len(valid_image_parts)} photo(s) from a home inspection:
- Section / Room: {section_name}
- Component / Item: {item_name}
- Current Status: {status}
- Inspector's Raw Field Note: "{raw}"

INSTRUCTIONS:
1. Synthesize the inspector's note with visual findings observed in the attached photo(s) to formulate an accurate and comprehensive narrative.
2. Structure the polished narrative with Observation, Implication, and Recommendation.
3. Recommend the appropriate defect severity status: "Safety Hazard" | "Defective" | "Marginal" | "Satisfactory".
4. Recommend the contractor trade.
5. Provide a 1-sentence executive summary bullet.
6. Provide a concise, descriptive caption for the primary photo.

Respond strictly with a valid JSON object with the following keys:
{{
  "polishedComments": "Formal expanded professional narrative following Observation, Implication, Recommendation.",
  "recommendedStatus": "Safety Hazard" | "Defective" | "Marginal" | "Satisfactory",
  "trade": "Plumbing" | "Electrical" | "HVAC" | "Roofing" | "Structural" | "General Contractor" | "Specialist",
  "summaryBullet": "A concise 1-sentence bullet summarizing the defect and required action for the client summary page.",
  "photoCaption": "Concise defect note for photo"
}}
Do NOT include markdown formatting or backticks around the JSON. Only return pure JSON.
"""
    else:
        # Text-only polishing
        prompt = f"""{SYSTEM_PROMPT}

Inspect the following field note from a home inspection:
- Section / Room: {section_name}
- Component / Item: {item_name}
- Current Status: {status}
- Number of attached photos: {photos_count}
- Inspector's Raw Field Note: "{raw}"

Respond strictly with a valid JSON object with the following keys:
{{
  "polishedComments": "Formal expanded professional narrative following Observation, Implication, Recommendation.",
  "recommendedStatus": "Safety Hazard" | "Defective" | "Marginal" | "Satisfactory",
  "trade": "Plumbing" | "Electrical" | "HVAC" | "Roofing" | "Structural" | "General Contractor" | "Specialist",
  "summaryBullet": "A concise 1-sentence bullet summarizing the defect and required action for the client summary page.",
  "photoCaption": "{item_name}"
}}
Do NOT include markdown formatting or backticks around the JSON. Only return pure JSON.
"""

    parts = list(valid_image_parts)
    parts.append({"text": prompt})

    req_body = {
        "contents": [
            {"parts": parts}
        ],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json"
        }
    }

    try:
        resp = await call_gemini_with_retry(req_body, max_retries=3, timeout=35.0)
        if not resp or resp.status_code != 200:
            return {
                "success": False,
                "error": f"Gemini error {resp.status_code if resp else 'timeout'}: {resp.text if resp else 'No response'}"
            }

        data = resp.json()
        raw_text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        
        # Clean possible markdown wrap
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        if raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
        raw_text = raw_text.strip()

        parsed = json.loads(raw_text)
        return {
            "success": True,
            "original": raw,
            "polished": parsed.get("polishedComments", raw),
            "recommendedStatus": parsed.get("recommendedStatus", status),
            "trade": parsed.get("trade", "General"),
            "summaryBullet": parsed.get("summaryBullet", ""),
            "photoCaption": parsed.get("photoCaption", "")
        }
    except Exception as e:
        logger.error(f"Error in polish_single_item: {e}")
        return {
            "success": False,
            "error": f"Failed to polish narrative: {str(e)}"
        }

async def batch_polish_inspection(inspection_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Scans all items in the inspection, filters those with defects, notes, or attached photos,
    and runs batch narrative polishing with Gemini Vision.
    """
    if not is_ai_configured():
        return {
            "success": False,
            "error": "Gemini API key is not configured in backend/.env."
        }

    sections = inspection_data.get("sections", [])
    items_to_process = []

    for sec in sections:
        sec_name = sec.get("name", "General")
        for item in sec.get("items", []):
            item_id = item.get("id")
            item_name = item.get("name", "")
            status = item.get("status", "Satisfactory")
            comments = (item.get("comments") or "").strip()
            photos = item.get("photos", [])

            # Process items marked Defective/Hazard/Marginal OR having substantive comments OR having photos
            if status in ["Defective", "Safety Hazard", "Marginal"] or len(comments) > 5 or len(photos) > 0:
                items_to_process.append({
                    "itemId": item_id,
                    "sectionName": sec_name,
                    "itemName": item_name,
                    "status": status,
                    "rawComments": comments,
                    "photosCount": len(photos),
                    "photos": photos
                })

    if not items_to_process:
        return {
            "success": True,
            "processedCount": 0,
            "results": {},
            "message": "No defective, noted, or photo items required polishing."
        }

    sem = asyncio.Semaphore(3)
    async def process_one(it_data):
        async with sem:
            res = await polish_single_item(
                section_name=it_data["sectionName"],
                item_name=it_data["itemName"],
                status=it_data["status"],
                raw_comments=it_data["rawComments"],
                photos_count=it_data["photosCount"],
                photos=it_data.get("photos", [])
            )
            if res.get("success"):
                return it_data["itemId"], {
                    "polishedComments": res.get("polished", ""),
                    "recommendedStatus": res.get("recommendedStatus", it_data["status"]),
                    "trade": res.get("trade", "General"),
                    "summaryBullet": res.get("summaryBullet", ""),
                    "photoCaption": res.get("photoCaption", "")
                }
            return it_data["itemId"], None

    tasks = [process_one(it) for it in items_to_process]
    completed = await asyncio.gather(*tasks, return_exceptions=True)

    results = {}
    for entry in completed:
        if isinstance(entry, tuple) and entry[1] is not None:
            results[entry[0]] = entry[1]

    return {
        "success": True,
        "processedCount": len(results),
        "results": results
    }

async def generate_executive_summary(inspection_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Generates a structured executive summary from an inspection report.
    """
    if not is_ai_configured():
        return {"success": False, "error": "Gemini API key is not configured."}

    client_info = inspection_data.get("clientInfo", {})
    sections = inspection_data.get("sections", [])

    defects = []
    for sec in sections:
        for item in sec.get("items", []):
            st = item.get("status")
            if st in ["Safety Hazard", "Defective", "Marginal"]:
                defects.append({
                    "section": sec.get("name"),
                    "item": item.get("name"),
                    "status": st,
                    "comments": item.get("comments", "")
                })

    prompt = f"""{SYSTEM_PROMPT}

Create a professional Executive Inspection Summary for:
Property Address: {client_info.get('inspectionAddress', 'Property')}
Client: {client_info.get('clientName', 'Client')}
Inspection Date: {client_info.get('inspectionDate', 'Recent')}

List of Deficiencies Observed:
{json.dumps(defects, indent=2)}

Respond with a JSON object:
{{
  "overallAssessment": "A 2-3 sentence executive overview of the property's condition.",
  "immediateSafetyHazards": ["bullet points of safety hazards"],
  "majorDefects": ["bullet points of major defects"],
  "recommendedContractors": ["Licensed Electrician", "Licensed Plumber", etc.]
}}
Return pure JSON only.
"""
    req_body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"}
    }

    try:
        resp = await call_gemini_with_retry(req_body, max_retries=3, timeout=30.0)
        if resp and resp.status_code == 200:
            data = resp.json()
            raw_text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
            if raw_text.startswith("```json"): raw_text = raw_text[7:]
            if raw_text.startswith("```"): raw_text = raw_text[3:]
            if raw_text.endswith("```"): raw_text = raw_text[:-3]
            return {
                "success": True,
                "summary": json.loads(raw_text.strip())
            }
        return {"success": False, "error": f"API error: {resp.status_code if resp else 'timeout'}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
