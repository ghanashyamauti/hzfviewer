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
from typing import Dict, Any, List, Optional
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

async def polish_single_item(
    section_name: str,
    item_name: str,
    status: str,
    raw_comments: str,
    photos_count: int = 0
) -> Dict[str, Any]:
    """
    Polishes a single inspection item's field notes into a professional narrative.
    """
    if not is_ai_configured():
        return {
            "success": False,
            "error": "Gemini API key is not configured in backend/.env."
        }

    if not raw_comments or len(raw_comments.strip()) < 3:
        # Nothing substantive to polish
        return {
            "success": True,
            "original": raw_comments,
            "polished": raw_comments,
            "recommendedStatus": status,
            "trade": "General",
            "summaryBullet": f"{item_name}: Inspected."
        }

    prompt = f"""{SYSTEM_PROMPT}

Inspect the following field note from a home inspection:
- Section / Room: {section_name}
- Component / Item: {item_name}
- Current Status: {status}
- Number of attached photos: {photos_count}
- Inspector's Raw Field Note: "{raw_comments}"

Respond strictly with a valid JSON object with the following keys:
{{
  "polishedComments": "Formal expanded professional narrative following Observation, Implication, Recommendation.",
  "recommendedStatus": "Safety Hazard" | "Defective" | "Marginal" | "Satisfactory",
  "trade": "Plumbing" | "Electrical" | "HVAC" | "Roofing" | "Structural" | "General Contractor" | "Specialist",
  "summaryBullet": "A concise 1-sentence bullet summarizing the defect and required action for the client summary page."
}}
Do NOT include markdown formatting or backticks around the JSON. Only return pure JSON.
"""

    req_body = {
        "contents": [
            {"parts": [{"text": prompt}]}
        ],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json"
        }
    }

    try:
        resp = await call_gemini_with_retry(req_body, max_retries=3, timeout=25.0)
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
            "original": raw_comments,
            "polished": parsed.get("polishedComments", raw_comments),
            "recommendedStatus": parsed.get("recommendedStatus", status),
            "trade": parsed.get("trade", "General"),
            "summaryBullet": parsed.get("summaryBullet", "")
        }
    except Exception as e:
        logger.error(f"Error in polish_single_item: {e}")
        return {
            "success": False,
            "error": f"Failed to polish narrative: {str(e)}"
        }

async def batch_polish_inspection(inspection_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Scans all items in the inspection, filters those with defects or notes,
    and runs batch narrative polishing.
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

            # We process items marked Defective/Hazard/Marginal OR having substantive comments
            if status in ["Defective", "Safety Hazard", "Marginal"] or len(comments) > 5:
                items_to_process.append({
                    "itemId": item_id,
                    "sectionName": sec_name,
                    "itemName": item_name,
                    "status": status,
                    "rawComments": comments,
                    "photosCount": len(photos)
                })

    if not items_to_process:
        return {
            "success": True,
            "processedCount": 0,
            "results": {},
            "message": "No defective or noted items required polishing."
        }

    # Batch into groups of up to 8 items to prevent context overflow and respect token limits
    results = {}
    batch_size = 8

    for i in range(0, len(items_to_process), batch_size):
        chunk = items_to_process[i:i + batch_size]
        prompt = f"""{SYSTEM_PROMPT}

Polish the following batch of home inspection items from mobile field notes.
Items list:
{json.dumps(chunk, indent=2)}

Respond strictly with a JSON object mapping each itemId to its polished output:
{{
  "results": {{
    "<itemId>": {{
      "polishedComments": "Formal expanded professional narrative following Observation, Implication, Recommendation.",
      "recommendedStatus": "Safety Hazard" | "Defective" | "Marginal" | "Satisfactory",
      "trade": "Plumbing" | "Electrical" | "HVAC" | "Roofing" | "Structural" | "General Contractor",
      "summaryBullet": "1-sentence executive bullet"
    }}
  }}
}}
Do NOT include markdown formatting. Return pure JSON.
"""
        url = get_gemini_url()
        req_body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json"
            }
        }

        try:
            resp = await call_gemini_with_retry(req_body, max_retries=3, timeout=35.0)
            if resp and resp.status_code == 200:
                data = resp.json()
                raw_text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                if raw_text.startswith("```json"): raw_text = raw_text[7:]
                if raw_text.startswith("```"): raw_text = raw_text[3:]
                if raw_text.endswith("```"): raw_text = raw_text[:-3]
                parsed = json.loads(raw_text.strip())
                batch_res = parsed.get("results") if (isinstance(parsed, dict) and isinstance(parsed.get("results"), dict)) else parsed
                if isinstance(batch_res, dict):
                    results.update(batch_res)
            else:
                logger.warning(f"Batch polish chunk failed with status {resp.status_code if resp else 'error'}")
        except Exception as e:
            logger.error(f"Error processing batch chunk: {e}")

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
