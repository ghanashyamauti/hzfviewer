"""
Quality Assurance (QA) & Compliance Rule Engine
Audits .hzf inspection reports for missing photos, omitted critical systems,
blank metadata, and legal compliance issues before client delivery.
"""

from typing import Dict, Any, List

CORE_SYSTEMS = [
    {"name": "Roof", "keywords": ["roof", "attic", "flashing", "shingle"]},
    {"name": "Electrical", "keywords": ["electric", "panel", "breaker", "wiring", "service"]},
    {"name": "Plumbing", "keywords": ["plumb", "water heater", "drain", "pipe", "supply", "waste"]},
    {"name": "Heating & Cooling", "keywords": ["hvac", "heat", "air condition", "cooling", "furnace"]},
    {"name": "Foundation & Structure", "keywords": ["foundation", "crawlspace", "structure", "basement", "framing"]}
]

def audit_inspection(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Performs comprehensive QA audit on inspection report data.
    Returns health score, issue list with severity, and completion statistics.
    """
    client_info = data.get("clientInfo", {})
    sections = data.get("sections", [])

    issues: List[Dict[str, Any]] = []
    total_items = 0
    defects_count = 0
    hazards_count = 0
    photos_count = 0

    # 1. Audit Client & Property Information
    req_meta = [
        ("inspectionAddress", "Property Address", "high"),
        ("clientName", "Client Full Name", "high"),
        ("inspectionDate", "Inspection Date", "high"),
        ("inspectorName", "Inspector Name", "medium"),
        ("propertyType", "Building Type", "low"),
        ("weather", "Weather Conditions", "low")
    ]

    for key, label, sev in req_meta:
        val = (client_info.get(key) or "").strip()
        if not val:
            issues.append({
                "type": "missing_metadata",
                "severity": sev,
                "field": key,
                "sectionId": None,
                "itemId": None,
                "title": f"Missing {label}",
                "message": f"Property details are missing '{label}' which is required on the final report."
            })

    # 2. Audit Checklist Items & Photos
    all_section_names = []

    for sec in sections:
        sec_id = sec.get("id")
        sec_name = sec.get("name", "General")
        all_section_names.append(sec_name.lower())
        items = sec.get("items", [])

        for it in items:
            total_items += 1
            it_id = it.get("id")
            it_name = it.get("name", "Item")
            st = it.get("status", "Satisfactory")
            comments = (it.get("comments") or "").strip()
            photos = it.get("photos", [])
            photos_count += len(photos)

            is_defect = st in ["Defective", "Safety Hazard"]
            if st == "Defective":
                defects_count += 1
            elif st == "Safety Hazard":
                hazards_count += 1

            # Rule: Defect without photos
            if is_defect and len(photos) == 0:
                issues.append({
                    "type": "missing_photo",
                    "severity": "high",
                    "sectionId": sec_id,
                    "itemId": it_id,
                    "title": f"No Photo Attached for {st}",
                    "message": f"'{it_name}' in section '{sec_name}' is marked as {st} but has 0 photos attached. Legal compliance requires photographic evidence."
                })

            # Rule: Defect without narrative/comment
            if is_defect and len(comments) < 5:
                issues.append({
                    "type": "missing_narrative",
                    "severity": "high",
                    "sectionId": sec_id,
                    "itemId": it_id,
                    "title": f"No Defect Description for {st}",
                    "message": f"'{it_name}' in section '{sec_name}' is marked as {st} but has no descriptive comments or recommendations."
                })

            # Rule: Photos without captions
            for p_idx, p in enumerate(photos):
                cap = (p.get("caption") or "").strip()
                if not cap and is_defect:
                    issues.append({
                        "type": "missing_caption",
                        "severity": "low",
                        "sectionId": sec_id,
                        "itemId": it_id,
                        "photoIndex": p_idx,
                        "title": "Photo Lacks Caption",
                        "message": f"Photo #{p_idx+1} on '{it_name}' ({sec_name}) does not have a descriptive caption."
                    })

    # 3. Audit Core Systems Completeness
    for sys in CORE_SYSTEMS:
        sys_name = sys["name"]
        keywords = sys["keywords"]
        found = any(any(kw in s_name for kw in keywords) for s_name in all_section_names)
        if not found and total_items > 0:
            issues.append({
                "type": "omitted_system",
                "severity": "medium",
                "sectionId": None,
                "itemId": None,
                "title": f"Missing Core System: {sys_name}",
                "message": f"Standard inspection protocols recommend inspecting '{sys_name}'. No corresponding section was detected in this file."
            })

    # 4. Compute Health Score
    # Start with 100. High issue = -15 pts, Medium = -7 pts, Low = -2 pts
    high_count = sum(1 for i in issues if i["severity"] == "high")
    med_count = sum(1 for i in issues if i["severity"] == "medium")
    low_count = sum(1 for i in issues if i["severity"] == "low")

    score_deduction = (high_count * 15) + (med_count * 7) + (low_count * 2)
    final_score = max(0, min(100, 100 - score_deduction))

    if total_items == 0:
        final_score = 0

    return {
        "success": True,
        "qaScore": final_score,
        "isApproved": (final_score >= 80 and high_count == 0),
        "statistics": {
            "totalItems": total_items,
            "defectsCount": defects_count,
            "hazardsCount": hazards_count,
            "photosCount": photos_count,
            "highIssues": high_count,
            "mediumIssues": med_count,
            "lowIssues": low_count
        },
        "issues": issues
    }
