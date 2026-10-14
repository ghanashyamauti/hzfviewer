"""
HZF & BIN File Parser and Packager
Handles extraction, parsing, XML serialization, and repacking of .hzf and .bin inspection files.
Supports both Home Inspector Pro (HIP) native containers (DamagePanels.xml, TabbedPanes.tpl,
PhotoInfo.xml, ClientInfo.xml) and standard/generic XML inspection archives.
"""

import io
import os
import zipfile
import base64
import datetime
import xml.etree.ElementTree as ET
from typing import Dict, Any, List, Tuple

def normalize_status(st: str) -> str:
    if not st:
        return "Satisfactory"
    lower = st.lower().strip()
    if any(k in lower for k in ["hazard", "danger", "safety", "seepage", "moisture", "shock"]):
        return "Safety Hazard"
    if any(k in lower for k in ["defect", "repair", "poor", "bad", "damaged"]):
        return "Defective"
    if any(k in lower for k in ["marginal", "fair", "maintenance", "monitor"]):
        return "Marginal"
    if any(k in lower for k in ["satisfactory", "good", "pass", "acceptable"]):
        return "Satisfactory"
    if any(k in lower for k in ["not inspected", "ni"]):
        return "Not Inspected"
    if any(k in lower for k in ["not present", "np", "n/a"]):
        return "Not Present"
    return st.strip()


def parse_hip_format(xml_files: Dict[str, str], image_map: Dict[str, str]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """
    Parses native Home Inspector Pro (HIP) .bin and .hzf archives containing:
    - ClientInfo.xml (Java XMLDecoder ClientInfo)
    - TabbedPanes.tpl (Java XMLDecoder TemplateInfo / SavedTabbedPane)
    - DamagePanels.xml (Java XMLDecoder DamagePanelInfo)
    - PhotoInfo.xml (Java XMLDecoder PhotoInfo)
    """
    client_info = {}
    sections = []

    # 1. Extract Client & Property Info from ClientInfo.xml
    client_xml_str = xml_files.get('ClientInfo.xml') or xml_files.get('clientinfo.xml')
    if client_xml_str:
        try:
            root = ET.fromstring(client_xml_str)
            raw_props = {}
            for void in root.iter('void'):
                prop = void.attrib.get('property')
                if prop and len(void) > 0:
                    val = ''.join(void.itertext()).strip()
                    if val:
                        raw_props[prop] = val

            # Format Address
            addr_parts = [
                raw_props.get('address', ''),
                raw_props.get('address2', ''),
                raw_props.get('city', ''),
                raw_props.get('state', ''),
                raw_props.get('zip', '')
            ]
            clean_address = ', '.join([p for p in addr_parts if p])
            if clean_address:
                client_info['inspectionAddress'] = clean_address

            # Format Client Name
            c_name_parts = [raw_props.get('firstName', ''), raw_props.get('lastName', '')]
            clean_name = ' '.join([p for p in c_name_parts if p]).strip()
            if clean_name:
                client_info['clientName'] = clean_name

            # Additional metadata
            if 'phone' in raw_props: client_info['clientPhone'] = raw_props['phone']
            if 'email' in raw_props: client_info['clientEmail'] = raw_props['email']
            if 'inspectorName' in raw_props: client_info['inspectorName'] = raw_props['inspectorName']
            if 'company' in raw_props: client_info['inspectionCompany'] = raw_props['company']
            if 'weather' in raw_props: client_info['weather'] = raw_props['weather']
            if 'otherInfo' in raw_props: client_info['propertyType'] = raw_props['otherInfo']

            # Date formatting
            raw_date = raw_props.get('inspectionDate', '')
            if raw_date and raw_date.isdigit():
                try:
                    ts = int(raw_date) / 1000.0
                    client_info['inspectionDate'] = datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d')
                except Exception:
                    client_info['inspectionDate'] = raw_date
            elif raw_date:
                client_info['inspectionDate'] = raw_date

        except Exception as e:
            print("Error parsing HIP ClientInfo.xml:", e)

    # 2. Extract Section / Room Names from TabbedPanes.tpl
    tab_names = []
    tpl_str = xml_files.get('TabbedPanes.tpl') or xml_files.get('tabbedpanes.tpl')
    if tpl_str:
        try:
            root = ET.fromstring(tpl_str)
            for void in root.iter('void'):
                if void.attrib.get('property') == 'tabbedPaneName':
                    s = void.find('string')
                    if s is not None and s.text and s.text.strip():
                        t_name = s.text.strip()
                        if t_name not in tab_names:
                            tab_names.append(t_name)
        except Exception as e:
            print("Error parsing TabbedPanes.tpl:", e)

    # 3. Extract Photos from PhotoInfo.xml
    photos_by_area_item = {}
    unassigned_photos = []

    photo_xml_str = xml_files.get('PhotoInfo.xml') or xml_files.get('photoinfo.xml')
    if photo_xml_str:
        try:
            root = ET.fromstring(photo_xml_str)
            for p_obj in root.iter('object'):
                if p_obj.attrib.get('class') == 'homeinspectorpro.PhotoInfo':
                    p_data = {}
                    for void in p_obj.findall('void'):
                        prop = void.attrib.get('property')
                        if prop:
                            val = ''.join(void.itertext()).strip()
                            if val:
                                p_data[prop] = val

                    fname = p_data.get('fileName', '')
                    if not fname:
                        continue

                    caption = p_data.get('caption', '')
                    area = p_data.get('areaName', '').strip()
                    item = p_data.get('itemName', '').strip()

                    d_url = image_map.get(fname) or image_map.get(os.path.basename(fname)) or ""
                    photo_record = {
                        "filename": fname,
                        "dataUrl": d_url,
                        "caption": caption
                    }

                    if area or item:
                        k = (area.lower(), item.lower())
                        photos_by_area_item.setdefault(k, []).append(photo_record)
                    else:
                        unassigned_photos.append(photo_record)

        except Exception as e:
            print("Error parsing PhotoInfo.xml:", e)

    # 4. Extract Damage Panels from DamagePanels.xml
    panels_by_area_item = {}
    damage_xml_str = xml_files.get('DamagePanels.xml') or xml_files.get('damagepanels.xml')
    if damage_xml_str:
        try:
            root = ET.fromstring(damage_xml_str)
            for p_obj in root.iter('object'):
                if p_obj.attrib.get('class') == 'homeinspectorpro.DamagePanelInfo':
                    p_name = ""
                    red_notes = []
                    black_notes = []
                    general_notes = []

                    for void in p_obj.findall('void'):
                        prop = void.attrib.get('property')
                        if prop == 'name':
                            s = void.find('string')
                            if s is not None and s.text:
                                p_name = s.text.strip()
                        elif prop == 'damageStatusRedVector':
                            red_notes = [s.text.strip() for s in void.iter('string') if s.text and s.text.strip()]
                        elif prop == 'damageStatusBlackVector':
                            black_notes = [s.text.strip() for s in void.iter('string') if s.text and s.text.strip()]
                        elif prop == 'damageStatusVector':
                            general_notes = [s.text.strip() for s in void.iter('string') if s.text and s.text.strip()]

                    if not p_name:
                        continue

                    # Match p_name against section tab
                    matched_tab = None
                    matched_item = p_name
                    for t in tab_names:
                        if p_name.lower().startswith(t.lower()):
                            matched_tab = t
                            matched_item = p_name[len(t):].strip()
                            break

                    if not matched_tab:
                        matched_tab = "General"
                        matched_item = p_name

                    if not matched_item:
                        matched_item = matched_tab

                    key = (matched_tab.lower(), matched_item.lower())
                    panels_by_area_item[key] = {
                        "tab": matched_tab,
                        "item": matched_item,
                        "red": red_notes,
                        "black": black_notes,
                        "general": general_notes
                    }
        except Exception as e:
            print("Error parsing DamagePanels.xml:", e)

    # 5. Extract Materials and Specifications from SelectionPanels.xml
    selections_by_area_item = {}
    sel_xml_str = xml_files.get('SelectionPanels.xml') or xml_files.get('selectionpanels.xml')
    if sel_xml_str:
        try:
            root = ET.fromstring(sel_xml_str)
            for s_obj in root.iter('object'):
                if s_obj.attrib.get('class') == 'homeinspectorpro.SelectionPanelInfo':
                    p_name = ""
                    materials = []
                    indices = []
                    desc = ""
                    for void in s_obj.findall('void'):
                        prop = void.attrib.get('property')
                        if prop == 'name':
                            s = void.find('string')
                            if s is not None and s.text:
                                p_name = s.text.strip()
                        elif prop == 'description':
                            desc = void.findtext('string') or ''
                        elif prop == 'materialTypesVector':
                            materials = [s.text.strip() for s in void.iter('string') if s.text and s.text.strip()]
                        elif prop == 'selectedIndices':
                            indices = [int(i.text) for i in void.iter('int') if i.text and i.text.isdigit()]

                    if p_name and indices and materials:
                        chosen = [materials[idx] for idx in indices if idx < len(materials)]
                        if chosen:
                            matched_tab = None
                            matched_item = p_name
                            for t in tab_names:
                                if p_name.lower().startswith(t.lower()):
                                    matched_tab = t
                                    matched_item = p_name[len(t):].strip()
                                    break
                            if not matched_tab:
                                matched_tab = "General"
                                matched_item = p_name
                            if not matched_item:
                                matched_item = desc or matched_tab
                            key = (matched_tab.lower(), matched_item.lower())
                            selections_by_area_item[key] = chosen
        except Exception as e:
            print("Error parsing SelectionPanels.xml:", e)

    if not tab_names:
        tab_set = []
        for (a, _) in list(panels_by_area_item.keys()) + list(photos_by_area_item.keys()) + list(selections_by_area_item.keys()):
            if a and a.title() not in tab_set:
                tab_set.append(a.title())
        tab_names = tab_set or ["General Inspection"]

    # 6. Assemble Sections & Items
    sec_idx = 1
    item_counter = 1

    for tab in tab_names:
        tab_lower = tab.lower()
        sec_items = []
        seen_items = set()

        for (a_low, i_low), p_info in panels_by_area_item.items():
            if a_low == tab_lower:
                item_name = p_info["item"]
                seen_items.add(i_low)

                reds = p_info["red"]
                blacks = p_info["black"]
                generals = p_info["general"]

                if reds:
                    is_hazard = any(any(w in n.lower() for w in ['hazard', 'danger', 'safety', 'shock', 'seepage', 'moisture', 'fire']) for n in reds)
                    status = "Safety Hazard" if is_hazard else "Defective"
                elif blacks:
                    status = "Marginal"
                else:
                    status = "Satisfactory"

                comment_blocks = []
                # Check for material specifications
                mat_specs = selections_by_area_item.get((a_low, i_low), [])
                if not mat_specs:
                    for (sa_low, si_low), s_list in selections_by_area_item.items():
                        if sa_low == a_low and (si_low in i_low or i_low in si_low):
                            mat_specs = s_list
                            break
                if mat_specs:
                    comment_blocks.append("• Materials & Specs: " + ", ".join(mat_specs))

                if reds:
                    comment_blocks.append("• " + "\n• ".join(reds))
                if blacks:
                    comment_blocks.append("• " + "\n• ".join(blacks))
                if generals and not (reds or blacks):
                    comment_blocks.append("• " + "\n• ".join(generals))

                comments_str = "\n\n".join(comment_blocks)

                item_photos = photos_by_area_item.get((a_low, i_low), [])
                if not item_photos:
                    for (pa_low, pi_low), p_list in photos_by_area_item.items():
                        if pa_low == tab_lower and (pi_low in i_low or i_low in pi_low):
                            item_photos = p_list
                            break

                sec_items.append({
                    "id": f"it_hip_{item_counter}",
                    "name": item_name,
                    "status": status,
                    "comments": comments_str,
                    "photos": item_photos
                })
                item_counter += 1

        for (pa_low, pi_low), p_list in photos_by_area_item.items():
            if pa_low == tab_lower and pi_low not in seen_items:
                seen_items.add(pi_low)
                sec_items.append({
                    "id": f"it_hip_{item_counter}",
                    "name": pi_low.title() if pi_low else "Inspection Photos",
                    "status": "Satisfactory",
                    "comments": "",
                    "photos": p_list
                })
                item_counter += 1

        if "detail" in tab_lower and unassigned_photos:
            sec_items.append({
                "id": f"it_hip_{item_counter}",
                "name": "Cover & Overview Photos",
                "status": "Satisfactory",
                "comments": "Inspection overview and cover photos",
                "photos": unassigned_photos
            })
            item_counter += 1
            unassigned_photos = []

        if sec_items:
            sections.append({
                "id": f"sec_hip_{sec_idx}",
                "name": tab,
                "summary": f"{len(sec_items)} inspection checkpoints in {tab}",
                "items": sec_items
            })
            sec_idx += 1

    if unassigned_photos:
        sections.append({
            "id": f"sec_hip_{sec_idx}",
            "name": "General Overview Photos",
            "summary": f"{len(unassigned_photos)} unclassified inspection photos",
            "items": [{
                "id": f"it_hip_{item_counter}",
                "name": "Overview Photos",
                "status": "Satisfactory",
                "comments": "",
                "photos": unassigned_photos
            }]
        })

    return client_info, sections


def parse_hzf_bytes(file_bytes: bytes, filename: str = "inspection.hzf") -> Dict[str, Any]:
    """
    Extract and parse an .hzf or .bin zip archive into clean JSON.
    Dynamically discovers all sections, items, client data, and photos from the file.
    Supports native Home Inspector Pro (HIP) and generic XML containers.
    """
    client_info = {}
    sections = []
    image_map = {}
    xml_files = {}

    if not zipfile.is_zipfile(io.BytesIO(file_bytes)):
        raise ValueError("The provided file is not a valid zip/hzf/bin archive container.")

    with zipfile.ZipFile(io.BytesIO(file_bytes), 'r') as z:
        for name in z.namelist():
            lower_name = name.lower()
            base_name = os.path.basename(name)

            if lower_name.endswith(('.jpg', '.jpeg', '.png', '.webp', '.bmp')):
                img_data = z.read(name)
                mime = 'image/png' if lower_name.endswith('.png') else 'image/jpeg'
                b64 = base64.b64encode(img_data).decode('utf-8')
                data_url = f"data:{mime};base64,{b64}"
                image_map[base_name] = data_url
                image_map[name] = data_url

            elif lower_name.endswith(('.xml', '.tpl', '.dat', '.txt')):
                try:
                    xml_files[base_name] = z.read(name).decode('utf-8', errors='ignore')
                except Exception:
                    pass

    # Step 1: Check for Home Inspector Pro (HIP) format first
    hip_keys = ['damagepanels.xml', 'tabbedpanes.tpl', 'photoinfo.xml']
    has_hip_signatures = any(k in [f.lower() for f in xml_files.keys()] for k in hip_keys)

    if has_hip_signatures:
        try:
            hip_client, hip_sections = parse_hip_format(xml_files, image_map)
            if hip_sections:
                client_info.update(hip_client)
                sections = hip_sections
        except Exception as e:
            print("HIP parser warning:", e)

    # Step 2: Fallback to Generic InspectionData.xml / report.xml
    if not sections:
        # Client XML
        client_xml_str = xml_files.get('ClientInfo.xml') or xml_files.get('client.xml')
        if not client_xml_str:
            for x_text in xml_files.values():
                if '<ClientName>' in x_text or '<InspectionAddress>' in x_text or '<Client' in x_text:
                    client_xml_str = x_text
                    break

        if client_xml_str:
            try:
                root = ET.fromstring(client_xml_str)
                for child in root.iter():
                    tag = child.tag.lower()
                    text = (child.text or '').strip()
                    if not text:
                        continue
                    if 'clientname' in tag or tag == 'client': client_info['clientName'] = text
                    elif 'phone' in tag and 'client' in tag: client_info['clientPhone'] = text
                    elif 'email' in tag and 'client' in tag: client_info['clientEmail'] = text
                    elif 'address' in tag: client_info['inspectionAddress'] = text
                    elif 'inspectorname' in tag or tag == 'inspector': client_info['inspectorName'] = text
                    elif 'license' in tag: client_info['inspectorLicense'] = text
                    elif 'company' in tag: client_info['inspectionCompany'] = text
                    elif 'date' in tag: client_info['inspectionDate'] = text
                    elif 'time' in tag: client_info['inspectionTime'] = text
                    elif 'weather' in tag: client_info['weather'] = text
                    elif 'propertytype' in tag or 'buildingtype' in tag: client_info['propertyType'] = text
                    elif 'yearbuilt' in tag: client_info['yearBuilt'] = text
                    elif 'squarefootage' in tag or 'sqft' in tag: client_info['squareFootage'] = text
                    elif 'foundation' in tag: client_info['foundationType'] = text
            except Exception as e:
                print("Generic Client XML parse warning:", e)

        # Inspection Sections
        inspection_xml = xml_files.get('InspectionData.xml') or xml_files.get('report.xml')
        if not inspection_xml:
            for x_text in xml_files.values():
                if '<Section' in x_text or '<Items' in x_text:
                    inspection_xml = x_text
                    break

        if inspection_xml:
            try:
                root = ET.fromstring(inspection_xml)
                for s_idx, sec_elem in enumerate(root.iter('Section')):
                    s_id = sec_elem.get('id') or f"sec_{s_idx+1}"
                    s_name = sec_elem.get('name') or sec_elem.findtext('Name') or f"Section {s_idx+1}"
                    s_summary = sec_elem.findtext('Summary') or ""

                    items = []
                    for i_idx, item_elem in enumerate(sec_elem.iter('Item')):
                        i_id = item_elem.get('id') or f"item_{s_id}_{i_idx+1}"
                        i_name = item_elem.get('name') or item_elem.findtext('Name') or f"Item {i_idx+1}"
                        raw_status = item_elem.findtext('Status') or item_elem.findtext('Rating') or "Satisfactory"
                        comments = item_elem.findtext('Comments') or item_elem.findtext('Narrative') or ""

                        photos = []
                        for p_elem in item_elem.iter('Photo'):
                            p_file = p_elem.get('filename') or (p_elem.text or '').strip()
                            p_cap = p_elem.get('caption') or ""
                            if p_file:
                                data_url = image_map.get(p_file) or image_map.get(os.path.basename(p_file)) or ""
                                photos.append({
                                    "filename": p_file,
                                    "dataUrl": data_url,
                                    "caption": p_cap
                                })

                        items.append({
                            "id": i_id,
                            "name": i_name,
                            "status": normalize_status(raw_status),
                            "comments": comments,
                            "photos": photos
                        })

                    sections.append({
                        "id": s_id,
                        "name": s_name,
                        "summary": s_summary,
                        "items": items
                    })
            except Exception as e:
                print("Generic Inspection XML parse warning:", e)

    # Step 3: If no structured sections could be identified, organize photos
    if not sections and image_map:
        sections = [
            {
                "id": "sec_mobile_photos",
                "name": "Imported Inspection Photos",
                "summary": "Photos extracted from file",
                "items": [
                    {
                        "id": f"it_photo_{idx+1}",
                        "name": os.path.splitext(fname)[0].replace('_', ' ').title(),
                        "status": "Satisfactory",
                        "comments": "",
                        "photos": [{"filename": fname, "dataUrl": durl, "caption": ""}]
                    }
                    for idx, (fname, durl) in enumerate(image_map.items())
                ]
            }
        ]

    return {
        "fileName": filename,
        "clientInfo": client_info,
        "sections": sections
    }


def build_hzf_bytes(data: Dict[str, Any]) -> bytes:
    """
    Package inspection JSON back into a valid .hzf ZIP archive.
    Writes ClientInfo.xml, InspectionData.xml, manifest.xml, and all photo binaries.
    """
    buffer = io.BytesIO()
    client = data.get('clientInfo', {})
    sections = data.get('sections', [])

    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        # 1. Generate ClientInfo.xml
        c_root = ET.Element("ClientData")
        for k, v in client.items():
            child = ET.SubElement(c_root, k)
            child.text = str(v or "")
        client_xml = ET.tostring(c_root, encoding='utf-8', xml_declaration=True)
        z.writestr("ClientInfo.xml", client_xml)

        # 2. Generate InspectionData.xml
        i_root = ET.Element("InspectionReport", created=datetime.datetime.now().isoformat(), version="2.0")
        secs_elem = ET.SubElement(i_root, "Sections")
        
        photos_to_write = {}

        for sec in sections:
            s_elem = ET.SubElement(secs_elem, "Section", id=str(sec.get('id', '')), name=str(sec.get('name', '')))
            s_summary = ET.SubElement(s_elem, "Summary")
            s_summary.text = str(sec.get('summary', ''))

            items_elem = ET.SubElement(s_elem, "Items")
            for item in sec.get('items', []):
                item_elem = ET.SubElement(items_elem, "Item", id=str(item.get('id', '')), name=str(item.get('name', '')))
                
                status_elem = ET.SubElement(item_elem, "Status")
                status_elem.text = str(item.get('status', 'Satisfactory'))

                comm_elem = ET.SubElement(item_elem, "Comments")
                comm_elem.text = str(item.get('comments', ''))

                photos_elem = ET.SubElement(item_elem, "Photos")
                for p in item.get('photos', []):
                    p_name = p.get('filename') or f"photo_{len(photos_to_write)+1}.jpg"
                    p_cap = p.get('caption', '')
                    ET.SubElement(photos_elem, "Photo", filename=p_name, caption=p_cap)

                    data_url = p.get('dataUrl', '')
                    if ',' in data_url and p_name not in photos_to_write:
                        try:
                            b64 = data_url.split(',', 1)[1]
                            photos_to_write[p_name] = base64.b64decode(b64)
                        except Exception:
                            pass

        insp_xml = ET.tostring(i_root, encoding='utf-8', xml_declaration=True)
        z.writestr("InspectionData.xml", insp_xml)

        # 3. Generate manifest.xml
        m_root = ET.Element("HZFManifest")
        ET.SubElement(m_root, "Software").text = "Home Inspector Pro Compatible Studio"
        ET.SubElement(m_root, "Version").text = "2.0"
        ET.SubElement(m_root, "ExportDate").text = datetime.datetime.now().isoformat()
        z.writestr("manifest.xml", ET.tostring(m_root, encoding='utf-8', xml_declaration=True))

        # 4. Write all photos
        for p_name, p_bytes in photos_to_write.items():
            z.writestr(p_name, p_bytes)

    buffer.seek(0)
    return buffer.getvalue()


def build_bin_bytes(data: Dict[str, Any]) -> bytes:
    """Alias for building container bytes, compatible with .bin and .hzf."""
    return build_hzf_bytes(data)


def get_clean_blank_template() -> Dict[str, Any]:
    """Returns a clean, standard Home Inspection template ready for mobile inspection data."""
    return {
        "fileName": "New_Inspection.hzf",
        "clientInfo": {
            "clientName": "",
            "clientPhone": "",
            "clientEmail": "",
            "inspectionAddress": "",
            "inspectorName": "",
            "inspectorLicense": "",
            "inspectionCompany": "",
            "inspectionDate": datetime.date.today().isoformat(),
            "inspectionTime": "",
            "propertyType": "",
            "yearBuilt": "",
            "squareFootage": "",
            "weather": ""
        },
        "sections": [
            {
                "id": "sec_roof",
                "name": "Roofing System",
                "summary": "Roof coverings, flashings, valleys, and gutters",
                "items": [
                    {"id": "it_roof_1", "name": "Roof Covering Materials", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_roof_2", "name": "Flashings & Valleys", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_roof_3", "name": "Gutters & Downspouts", "status": "Satisfactory", "comments": "", "photos": []}
                ]
            },
            {
                "id": "sec_exterior",
                "name": "Exterior & Grounds",
                "summary": "Siding, trim, walkways, grading, and drainage",
                "items": [
                    {"id": "it_ext_1", "name": "Siding, Flashing & Trim", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_ext_2", "name": "Walkways & Driveway", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_ext_3", "name": "Grading & Drainage", "status": "Satisfactory", "comments": "", "photos": []}
                ]
            },
            {
                "id": "sec_electrical",
                "name": "Electrical System",
                "summary": "Service entrance, main panel, branch wiring, GFCI/AFCI",
                "items": [
                    {"id": "it_elec_1", "name": "Main Service Panel & Wiring", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_elec_2", "name": "GFCI & AFCI Protection", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_elec_3", "name": "Branch Circuits & Outlets", "status": "Satisfactory", "comments": "", "photos": []}
                ]
            },
            {
                "id": "sec_plumbing",
                "name": "Plumbing System",
                "summary": "Water supply, water heater, drain/waste/vent lines",
                "items": [
                    {"id": "it_plumb_1", "name": "Main Water Supply & Pressure", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_plumb_2", "name": "Water Heater Equipment", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_plumb_3", "name": "Drain, Waste & Vent Lines", "status": "Satisfactory", "comments": "", "photos": []}
                ]
            },
            {
                "id": "sec_hvac",
                "name": "Heating & Cooling (HVAC)",
                "summary": "Air conditioning equipment and heating furnace",
                "items": [
                    {"id": "it_hvac_1", "name": "Air Conditioning Equipment", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_hvac_2", "name": "Heating Equipment & Furnace", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_hvac_3", "name": "Ducts & Air Distribution", "status": "Satisfactory", "comments": "", "photos": []}
                ]
            },
            {
                "id": "sec_interior",
                "name": "Interior & Rooms",
                "summary": "Ceilings, walls, floors, doors, and windows",
                "items": [
                    {"id": "it_int_1", "name": "Ceilings & Walls", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_int_2", "name": "Doors & Windows", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_int_3", "name": "Floors & Stairs", "status": "Satisfactory", "comments": "", "photos": []}
                ]
            },
            {
                "id": "sec_attic",
                "name": "Attic & Insulation",
                "summary": "Roof framing structure and insulation levels",
                "items": [
                    {"id": "it_attic_1", "name": "Attic Insulation Depth", "status": "Satisfactory", "comments": "", "photos": []},
                    {"id": "it_attic_2", "name": "Roof Structure & Trusses", "status": "Satisfactory", "comments": "", "photos": []}
                ]
            },
            {
                "id": "sec_foundation",
                "name": "Foundation & Structure",
                "summary": "Foundation perimeter, slab, or crawlspace",
                "items": [
                    {"id": "it_found_1", "name": "Foundation Perimeter & Slab", "status": "Satisfactory", "comments": "", "photos": []}
                ]
            }
        ]
    }
