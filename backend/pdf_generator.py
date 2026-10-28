"""
HZF & BIN Inspector Studio - PDF Report Generator
Produces pixel-accurate, high-fidelity PDF inspection reports matching Home Inspector Pro (iText)
specification and 'Mantra Mirari Flat No.E-404.pdf'.

Features:
- Full-page Royal Blue master frame (#3366FF, 4pt border)
- Two-pass NumberedCanvas for dynamic 'Page X of Y' numbering (omits cover)
- Dual-cell running header banner on pages 2+
- Cover page with custom hero photo upload/selection, client info, and inspector credentials
- Standard Inspection Details & Wall Orientation diagram
- 5-Column status rating matrix with centered 'X' marks
- Red-highlighted defect observations and recommendations (#FF0000)
- 2x3 Photo Grid pages with 150x200pt portrait scaling, black border, and captions
- Full 3-column Report Summary deficiency index
- Native PDF outline bookmarks
"""

import io
import os
import re
import base64
from typing import Dict, Any, List, Optional, Tuple
from PIL import Image as PILImage, ImageOps

from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    Image as RLImage,
    PageBreak,
    KeepTogether,
    Flowable
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT, TA_JUSTIFY
from reportlab.pdfbase.pdfdoc import PDFObjectReference

# ==============================================================================
# COLOR & STYLE DEFINITIONS
# ==============================================================================
BLUE_FRAME = colors.HexColor("#3366FF")       # Royal Blue for borders & banners
GRAY_BAR = colors.HexColor("#C0C0C0")         # Silver/Gray for item ribbons
ALERT_RED = colors.HexColor("#FF0000")        # Pure Red for defects & observations
BORDER_BLACK = colors.HexColor("#000000")     # Black for borders & normal text
WHITE = colors.HexColor("#FFFFFF")
LIGHT_GRAY_LINE = colors.HexColor("#B0B0B0")

PAGE_W, PAGE_H = letter  # 612 x 792 pt

class BookmarkFlowable(Flowable):
    """Adds a named destination bookmark to the PDF outline."""
    def __init__(self, key: str, title: str, level: int = 0):
        super().__init__()
        self.key = key
        self.title = title
        self.level = level
        self.width = 0
        self.height = 0

    def wrap(self, availWidth, availHeight):
        return 0, 0

    def draw(self):
        canv = self.canv
        canv.bookmarkPage(self.key)
        canv.addOutlineEntry(self.title, self.key, level=self.level, closed=None)

# ==============================================================================
# TWO-PASS NUMBERED CANVAS (Borders, Headers, Footers & Page Counts)
# ==============================================================================
class HipReportCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.pages = []
        self._bookmark_registry = []  # Collect bookmarks during first pass
        self.header_company = "N G Home Inspection Services"
        self.header_property = "Property Inspection Report"
        self.showOutline()

    def bookmarkPage(self, key: str, fit: str = "Fit", **kwargs):
        """
        In a deferred two-pass canvas, do NOT create the actual PDF destination
        during story layout (first pass) — _pageNumber is wrong at this point.
        Just record the bookmark info. Destinations are created in save().
        """
        logical_page = len(self.pages)
        self._bookmark_registry.append((key, fit, kwargs, logical_page))
        # Do NOT call super().bookmarkPage() here — it would create a
        # destination pointing to "Page0" which doesn't exist.

    def set_header_info(self, company: str, property_address: str):
        if company:
            self.header_company = company.strip()
        if property_address:
            parts = [p.strip() for p in property_address.split(',') if p.strip()]
            if len(parts) >= 2:
                self.header_property = f"{parts[0]}, {parts[1]}"
            elif parts:
                self.header_property = parts[0]

    def showPage(self):
        self.pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self.pages)
        for page_idx, page_state in enumerate(self.pages):
            self.__dict__.update(page_state)
            # Create bookmark destinations on the correct page during second pass
            for bm_key, bm_fit, bm_kwargs, bm_page in self._bookmark_registry:
                if bm_page == page_idx:
                    super().bookmarkPage(bm_key, fit=bm_fit, **bm_kwargs)
            self.draw_page_decorations(page_idx + 1, num_pages)
            super().showPage()
        super().save()

    def draw_page_decorations(self, page_num: int, total_pages: int):
        self.saveState()

        # 1. Full-page Royal Blue outer border (4pt stroke) on ALL pages
        self.setStrokeColor(BLUE_FRAME)
        self.setLineWidth(4.0)
        self.rect(18.0, 18.0, PAGE_W - 36.0, PAGE_H - 36.0, stroke=1, fill=0)

        # 2. Running Blue Header Banner (on pages 2 and onward)
        if page_num > 1:
            header_y = PAGE_H - 38.5  # ~753.5 pt
            header_h = 18.5
            header_w = PAGE_W - 40.0  # ~572 pt

            # Top blue solid bar
            self.setFillColor(BLUE_FRAME)
            self.rect(20.0, header_y, header_w, header_h, stroke=0, fill=1)

            # Left company text (White, Helvetica-Bold, 9.5pt)
            self.setFillColor(WHITE)
            self.setFont("Helvetica-Bold", 9.5)
            self.drawString(28.0, header_y + 5.0, self.header_company)

            # Right property address text (White, Helvetica, 9.5pt)
            self.setFont("Helvetica", 9.5)
            self.drawRightString(PAGE_W - 28.0, header_y + 5.0, self.header_property)

            # Subtle vertical white separator in middle
            self.setStrokeColor(WHITE)
            self.setLineWidth(0.5)
            self.line(PAGE_W / 2.0, header_y + 2.0, PAGE_W / 2.0, header_y + header_h - 2.0)

            # 3. Running Footer: 'Page X of Y' (omitting cover from count)
            body_page = page_num - 1
            body_total = max(1, total_pages - 1)
            footer_text = f"Page {body_page} of {body_total}"
            self.setFillColor(BORDER_BLACK)
            self.setFont("Helvetica", 9.0)
            self.drawRightString(PAGE_W - 32.0, 24.0, footer_text)

        self.restoreState()


# ==============================================================================
# HELPER: IMAGE PROCESSOR & CONVERTER
# ==============================================================================
def process_image_to_flowable(img_source: Any, max_width_pt: float, max_height_pt: float, border: bool = True) -> Optional[Flowable]:
    """
    Decodes an image from base64, URL, filepath, or bytes, corrects EXIF orientation,
    resizes to fit bounds preserving aspect ratio, and wraps in an outlined container if needed.
    """
    if not img_source:
        return None

    img_bytes = None
    try:
        if isinstance(img_source, str):
            if img_source.startswith("data:image"):
                # Base64 data URL
                header, b64_str = img_source.split(",", 1)
                img_bytes = base64.b64decode(b64_str)
            elif os.path.exists(img_source):
                with open(img_source, "rb") as fp:
                    img_bytes = fp.read()
            else:
                try:
                    img_bytes = base64.b64decode(img_source)
                except Exception:
                    return None
        elif isinstance(img_source, bytes):
            img_bytes = img_source

        if not img_bytes:
            return None

        pil_img = PILImage.open(io.BytesIO(img_bytes))
        # Handle EXIF rotation (smartphones often store vertical photos rotated)
        try:
            pil_img = ImageOps.exif_transpose(pil_img)
        except Exception:
            pass

        orig_w, orig_h = pil_img.size
        if orig_w == 0 or orig_h == 0:
            return None

        # Calculate fitted aspect ratio dimensions
        ratio = min(max_width_pt / orig_w, max_height_pt / orig_h)
        target_w = orig_w * ratio
        target_h = orig_h * ratio

        # Save normalized image buffer
        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=88)
        buf.seek(0)

        rl_img = RLImage(buf, width=target_w, height=target_h)

        if border:
            tbl = Table([[rl_img]], colWidths=[target_w], rowHeights=[target_h])
            tbl.setStyle(TableStyle([
                ('BOX', (0, 0), (-1, -1), 0.5, BORDER_BLACK),
                ('PADDING', (0, 0), (-1, -1), 0),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ]))
            return tbl
        return rl_img

    except Exception as e:
        print(f"Failed to process image: {e}")
        return None


# ==============================================================================
# HELPER: STATUS MATRIX BUILDER
# ==============================================================================
def build_status_matrix_table(status_str: str) -> Table:
    """
    Builds the exact 5-column Home Inspector Pro status rating matrix:
    [ Acceptable | Marginal | Defective | N/A | None ]
    With a bold 'X' stamped inside the active column.
    """
    st = (status_str or "").strip().lower()

    checked_idx = 4  # Default 'None'
    if any(k in st for k in ["satisfactory", "pass", "acceptable", "good"]):
        checked_idx = 0
    elif any(k in st for k in ["marginal", "fair", "maintenance"]):
        checked_idx = 1
    elif any(k in st for k in ["defective", "defect", "safety hazard", "hazard", "poor", "damaged"]):
        checked_idx = 2
    elif any(k in st for k in ["n/a", "not present", "not inspected", "ni", "np"]):
        checked_idx = 3

    style_hdr = ParagraphStyle(
        'MatrixHeader',
        fontName='Helvetica',
        fontSize=6.0,
        leading=7.0,
        alignment=TA_CENTER,
        textColor=BORDER_BLACK
    )
    style_x = ParagraphStyle(
        'MatrixX',
        fontName='Helvetica-Bold',
        fontSize=13,
        leading=14,
        alignment=TA_CENTER,
        textColor=BORDER_BLACK
    )

    headers = [
        Paragraph("Accept.", style_hdr),
        Paragraph("Margin.", style_hdr),
        Paragraph("Defect.", style_hdr),
        Paragraph("N/A", style_hdr),
        Paragraph("None", style_hdr),
    ]

    boxes = ["", "", "", "", ""]
    boxes[checked_idx] = Paragraph("X", style_x)

    col_w = 26.0  # Total width = 5 * 26 = 130 pt
    matrix_tbl = Table([headers, boxes], colWidths=[col_w] * 5, rowHeights=[12.0, 20.0])
    matrix_tbl.setStyle(TableStyle([
        ('BOX', (0, 1), (0, 1), 0.75, BORDER_BLACK),
        ('BOX', (1, 1), (1, 1), 0.75, BORDER_BLACK),
        ('BOX', (2, 1), (2, 1), 0.75, BORDER_BLACK),
        ('BOX', (3, 1), (3, 1), 0.75, BORDER_BLACK),
        ('BOX', (4, 1), (4, 1), 0.75, BORDER_BLACK),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('PADDING', (0, 0), (-1, -1), 2),
        ('TOPPADDING', (0, 1), (-1, 1), 2),
    ]))
    return matrix_tbl


def make_gray_banner(txt: str, style: ParagraphStyle) -> Table:
    t = Table([[Paragraph(f"<b>{txt}</b>", style)]], colWidths=[534.0], rowHeights=[17.0])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), GRAY_BAR),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 1),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
    ]))
    return t


# ==============================================================================
# MAIN GENERATOR FUNCTION
# ==============================================================================
def generate_hip_inspection_pdf(
    inspection_data: Dict[str, Any],
    custom_cover_image: Optional[Any] = None,
    custom_inspector_info: Optional[Dict[str, str]] = None
) -> bytes:
    """
    Compiles the complete inspection into a downloadable PDF binary matching
    Mantra Mirari Flat No.E-404.pdf.
    """
    buffer = io.BytesIO()

    # Document Geometry: US Letter, margins inside the 18pt blue border
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        leftMargin=38.0,
        rightMargin=38.0,
        topMargin=46.0,
        bottomMargin=36.0
    )

    client_info = inspection_data.get('clientInfo', {}) or {}
    sections = inspection_data.get('sections', []) or []

    # Inspector Info defaults from custom info, clientInfo, or sample defaults
    inspector = custom_inspector_info or {}
    company_name = inspector.get('companyName') or client_info.get('inspectionCompany') or "N G Home Inspection Services"
    inspector_name = inspector.get('inspectorName') or client_info.get('inspectorName') or "Nitin Gujarathi"
    inspector_address = inspector.get('officeAddress') or "4_4 Yugaymangal complex, Kothrud, Pune, Maharashtra 411038"
    inspector_phone = inspector.get('phone') or client_info.get('clientPhone') or "00919890002635"
    inspector_email = inspector.get('email') or client_info.get('clientEmail') or "niting@macj.in"

    prop_address = client_info.get('inspectionAddress') or "Flat No.E-404, Mantra Mirari, Mundhwa, Pune, Maharashtra, 411036"
    client_name = client_info.get('clientName') or "Mantra Mirari"
    agent_name = client_info.get('realEstateAgent') or "SC,SS,STE(AK)  -"
    insp_date = client_info.get('inspectionDate') or "9/24/2026"
    insp_time = client_info.get('inspectionTime') or "11.30 PM"
    weather = client_info.get('weather') or "Cloudy"
    prop_type = client_info.get('propertyType') or "4.5BHK on 4th Floor"

    styles = getSampleStyleSheet()

    style_cover_company = ParagraphStyle(
        'CoverCompany',
        fontName='Times-BoldItalic',
        fontSize=17,
        leading=21,
        alignment=TA_CENTER,
        textColor=WHITE
    )
    style_cover_title = ParagraphStyle(
        'CoverTitle',
        fontName='Helvetica-Bold',
        fontSize=12,
        leading=15,
        alignment=TA_CENTER,
        textColor=WHITE
    )
    style_sec_title = ParagraphStyle(
        'SecTitle',
        fontName='Helvetica',
        fontSize=20,
        leading=24,
        alignment=TA_CENTER,
        textColor=BORDER_BLACK,
        spaceAfter=12
    )
    style_item_title = ParagraphStyle(
        'ItemTitle',
        fontName='Helvetica-Bold',
        fontSize=10.5,
        leading=13,
        alignment=TA_LEFT,
        textColor=BORDER_BLACK
    )
    style_body = ParagraphStyle(
        'Body',
        fontName='Helvetica',
        fontSize=9.5,
        leading=13,
        alignment=TA_LEFT,
        textColor=BORDER_BLACK
    )
    style_defect_bullet = ParagraphStyle(
        'DefectBullet',
        fontName='Helvetica',
        fontSize=9.5,
        leading=13,
        alignment=TA_LEFT,
        textColor=ALERT_RED
    )
    style_caption = ParagraphStyle(
        'PhotoCaption',
        fontName='Helvetica',
        fontSize=9.0,
        leading=11,
        alignment=TA_CENTER,
        textColor=BORDER_BLACK
    )

    story = []

    # ==========================================================================
    # PAGE 1: COVER PAGE
    # ==========================================================================
    story.append(BookmarkFlowable("cover_page", "Cover Page", level=0))

    # Top Blue Header Banner
    cover_banner_content = [
        [Paragraph(company_name, style_cover_company)],
        [Paragraph("Property Inspection Report", style_cover_title)]
    ]
    cover_banner = Table(cover_banner_content, colWidths=[534.0], rowHeights=[26.0, 18.0])
    cover_banner.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), BLUE_FRAME),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
    ]))
    story.append(cover_banner)
    story.append(Spacer(1, 14))

    # Cover Hero Image
    cover_img_source = custom_cover_image
    if not cover_img_source:
        for s in sections:
            for it in s.get('items', []):
                photos = it.get('photos', [])
                if photos and isinstance(photos[0], dict) and photos[0].get('dataUrl'):
                    cover_img_source = photos[0].get('dataUrl')
                    break
            if cover_img_source:
                break

    if not cover_img_source:
        default_asset = os.path.join(os.path.dirname(__file__), "assets", "default_cover.jpeg")
        if os.path.exists(default_asset):
            cover_img_source = default_asset

    hero_flowable = process_image_to_flowable(cover_img_source, max_width_pt=270.0, max_height_pt=340.0, border=True)
    if hero_flowable:
        hero_container = Table([[hero_flowable]], colWidths=[534.0])
        hero_container.setStyle(TableStyle([
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('PADDING', (0, 0), (-1, -1), 0),
        ]))
        story.append(hero_container)
    else:
        story.append(Spacer(1, 150))

    story.append(Spacer(1, 12))

    # Property Details Card
    prop_lines = [
        Paragraph(f"<b>{prop_address}</b>", ParagraphStyle('CoverAddr', fontName='Helvetica', fontSize=10.5, leading=13, alignment=TA_CENTER)),
        Spacer(1, 6),
        Paragraph(f"Inspection prepared for: <b>{client_name}</b>", ParagraphStyle('CoverPrep', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
        Paragraph(f"Real Estate Agent: {agent_name}", ParagraphStyle('CoverAgent', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
        Spacer(1, 4),
        Paragraph(f"Date of Inspection: {insp_date}  Time: {insp_time}", ParagraphStyle('CoverDT', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
        Paragraph(f"Weather: {weather}", ParagraphStyle('CoverW', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
        Paragraph(f"<b>{prop_type}</b>", ParagraphStyle('CoverPT', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
        Spacer(1, 10),
        Paragraph(f"Inspector: <b>{inspector_name}</b>", ParagraphStyle('CoverInsp', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
        Paragraph(f"{inspector_address}", ParagraphStyle('CoverAddr2', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
        Paragraph(f"Phone: {inspector_phone}", ParagraphStyle('CoverPh', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
        Paragraph(f"Email: {inspector_email}", ParagraphStyle('CoverEm', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)),
    ]
    story.extend(prop_lines)
    story.append(PageBreak())

    # Check if inspection data already includes Inspection Details and General Recommendations
    insp_details_sec = next((s for s in sections if (s.get('name') or '').strip().lower() == "inspection details"), None)
    has_custom_general_recom = any("recommend" in (s.get('name') or '').lower() for s in sections)

    # ==========================================================================
    # PAGE 2: INSPECTION DETAILS & WALL ORIENTATION REFERENCE
    # ==========================================================================
    story.append(BookmarkFlowable("insp_details", "Inspection Details", level=0))
    story.append(Paragraph("Inspection Details", style_sec_title))

    intro_title = Paragraph("<b>INTRODUCTION:</b>", ParagraphStyle('IntroH', fontName='Helvetica-Bold', fontSize=10.5, leading=14))
    intro_p1 = Paragraph(
        "We appreciate the opportunity to conduct this inspection for you! Please carefully read your entire "
        "Inspection Report. Call us after you have reviewed your report, so we can go over any questions "
        "you may have. Remember, when the inspection is completed and the report is delivered, we are still "
        "available to you for any questions you may have, throughout the entire closing process.",
        style_body
    )
    intro_p2 = Paragraph(
        "Properties being inspected do not \"Pass\" or \"Fail.\" - The following report is based on an inspection "
        "of the visible portion of the structure; inspection may be limited by vegetation and possessions. "
        "Depending upon the age of the property, some items like GFCI outlets may not be installed; this "
        "report will focus on safety and function, not current code. This report identifies specific non-code, "
        "non-cosmetic concerns that the inspector feels may need further investigation or repair.",
        style_body
    )
    intro_p3 = Paragraph(
        "For your safety and liability purposes, we recommend that licensed contractors evaluate and repair "
        "any critical concerns and defects. Note that this report is a snapshot in time. We recommend that "
        "you or your representative carry out a final walk-through inspection immediately before closing to "
        "check the condition of the property, using this report as a guide.",
        style_body
    )
    story.extend([intro_title, Spacer(1, 4), intro_p1, Spacer(1, 6), intro_p2, Spacer(1, 6), intro_p3, Spacer(1, 10)])

    # Standard Details Items
    story.append(make_gray_banner("1. Attendance", style_item_title))
    story.append(Spacer(1, 2))
    story.append(Paragraph("In Attendance: Site team present.", style_body))
    story.append(Spacer(1, 6))

    story.append(make_gray_banner("2. Home Type", style_item_title))
    story.append(Spacer(1, 2))
    story.append(Paragraph(f"Home Type: {prop_type}.", style_body))
    story.append(Spacer(1, 6))

    story.append(make_gray_banner("3. Occupancy", style_item_title))
    story.append(Spacer(1, 2))
    story.append(Paragraph("Occupancy: Vacant", style_body))
    story.append(Spacer(1, 6))

    story.append(make_gray_banner("4. Wall Reference", style_item_title))
    story.append(Spacer(1, 2))

    wall_matrix = build_status_matrix_table("n/a")
    wall_asset = os.path.join(os.path.dirname(__file__), "assets", "wall_reference.jpeg")
    wall_diagram = process_image_to_flowable(wall_asset, max_width_pt=240.0, max_height_pt=180.0, border=True)

    if wall_diagram:
        wall_composite = Table([[wall_matrix], [Spacer(1, 6)], [wall_diagram]], colWidths=[534.0])
        wall_composite.setStyle(TableStyle([
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('PADDING', (0, 0), (-1, -1), 0),
        ]))
        story.append(wall_composite)
    else:
        story.append(wall_matrix)

    story.append(Spacer(1, 4))
    story.append(Paragraph("For every area, Door/Entrance is the reference point to relate to the walls", ParagraphStyle('WallCap', fontName='Helvetica', fontSize=9.5, leading=12, alignment=TA_CENTER)))

    # If the inspection has custom items in Inspection Details (other than wall reference)
    if insp_details_sec:
        extra_items = [it for it in (insp_details_sec.get('items', []) or []) if "wall reference" not in (it.get('name') or '').lower()]
        for it_idx, item in enumerate(extra_items):
            story.append(Spacer(1, 6))
            story.append(make_gray_banner(f"{5 + it_idx}. {item.get('name', 'Detail')}", style_item_title))
            story.append(Spacer(1, 2))
            if item.get('comments'):
                story.append(Paragraph(item.get('comments'), style_body))

    story.append(PageBreak())

    # ==========================================================================
    # PAGES 3+: INSPECTION ROOM & SYSTEM SECTIONS
    # ==========================================================================
    summary_findings = []

    for s_idx, sec in enumerate(sections):
        sec_name = sec.get('name', f'Section {s_idx+1}')
        if sec_name.strip().lower() == "inspection details":
            continue  # Already seamlessly integrated on Page 2

        items = sec.get('items', []) or []
        if not items:
            continue

        sec_bookmark_key = f"sec_{s_idx}"
        story.append(BookmarkFlowable(sec_bookmark_key, sec_name, level=0))
        story.append(Paragraph(sec_name, style_sec_title))

        for it_idx, item in enumerate(items):
            it_name = item.get('name', f'Item {it_idx+1}')
            it_status = item.get('status', 'Satisfactory')
            comments_raw = item.get('comments', '') or ''
            photos = item.get('photos', []) or []

            # Gray Title Banner for Item
            item_banner = make_gray_banner(f"{it_idx+1}. {it_name}", style_item_title)
            story.append(item_banner)
            story.append(Spacer(1, 3))

            # Status Matrix Table
            matrix_tbl = build_status_matrix_table(it_status)

            # Extract lines
            lines = [l.strip() for l in comments_raw.split('\n') if l.strip()]
            obs_lines = []
            mat_lines = []
            for l in lines:
                l_clean = re.sub(r'^[•\-\*\s]+', '', l).strip()
                if l_clean.lower().startswith('materials:'):
                    mat_lines.append(l_clean)
                elif l_clean.lower().startswith('observations:'):
                    continue
                elif l_clean:
                    obs_lines.append(l_clean)

            # Collect for Report Summary
            st_lower = it_status.lower()
            is_defective = any(k in st_lower for k in ["defect", "hazard", "poor", "damaged", "leak"])
            is_marginal = any(k in st_lower for k in ["marginal", "fair", "maintenance"])
            if (is_defective or is_marginal or obs_lines) and it_name.lower() != "location" and sec_name != "Inspection Details":
                summary_findings.append({
                    "section": sec_name,
                    "item_index": it_idx + 1,
                    "item_name": it_name,
                    "findings": obs_lines if obs_lines else [f"Condition marked as {it_status}."]
                })

            # Check for inline Location photo
            inline_photo_flowable = None
            if it_name.lower() == "location" and photos:
                inline_p = photos[0]
                inline_photo_flowable = process_image_to_flowable(
                    inline_p.get('dataUrl'),
                    max_width_pt=150.0,
                    max_height_pt=190.0,
                    border=True
                )
                photo_caption = inline_p.get('caption') or "Location"

            if inline_photo_flowable:
                # Build photo cell with caption underneath
                photo_cell = Table(
                    [[inline_photo_flowable], [Paragraph(photo_caption, style_caption)]],
                    colWidths=[200.0]
                )
                photo_cell.setStyle(TableStyle([
                    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                    ('PADDING', (0, 0), (-1, -1), 0),
                ]))

                # First row: matrix (left) + photo (right)
                table_grid = [[matrix_tbl, photo_cell]]

                # Append materials and observations below the photo row
                # so nothing is skipped for location items
                for m in mat_lines:
                    table_grid.append(["", Paragraph(f"<b>Materials:</b> {m.split(':', 1)[-1].strip()}", style_body)])
                if obs_lines:
                    table_grid.append(["", Paragraph("<b>Observations:</b>", style_body)])
                    for obs in obs_lines:
                        clean_obs = obs.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                        table_grid.append(["", Paragraph(f'<font color="#ff0000">• {clean_obs}</font>', style_defect_bullet)])

                item_table = Table(table_grid, colWidths=[140.0, 394.0])
                style_cmds = [
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('ALIGN', (1, 0), (1, 0), 'CENTER'),
                    ('PADDING', (0, 0), (-1, -1), 0),
                    ('RIGHTPADDING', (0, 0), (0, -1), 10),
                ]
                if len(table_grid) > 1:
                    # Observation rows below the photo: left-aligned with padding
                    style_cmds.append(('ALIGN', (1, 1), (1, -1), 'LEFT'))
                    style_cmds.append(('LEFTPADDING', (1, 1), (1, -1), 8))
                    style_cmds.append(('BOTTOMPADDING', (1, 1), (1, -1), 2))
                item_table.setStyle(TableStyle(style_cmds))
                story.append(item_table)
            else:
                # Multi-row layout for observations so Table splits smoothly across pages
                content_rows = []
                for m in mat_lines:
                    content_rows.append(Paragraph(f"<b>Materials:</b> {m.split(':', 1)[-1].strip()}", style_body))

                if obs_lines:
                    content_rows.append(Paragraph("<b>Observations:</b>", style_body))
                    for obs in obs_lines:
                        # Clean special characters that might break ReportLab XML parser
                        clean_obs = obs.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                        content_rows.append(Paragraph(f"<font color=\"#ff0000\">• {clean_obs}</font>", style_defect_bullet))

                if not content_rows:
                    content_rows = [Spacer(1, 1)]

                # Build 2-column multi-row table: Col 0 has matrix on row 0, Col 1 has each paragraph on its own row
                table_grid = []
                table_grid.append([matrix_tbl, content_rows[0]])
                for row_elem in content_rows[1:]:
                    table_grid.append(["", row_elem])

                item_table = Table(table_grid, colWidths=[140.0, 394.0])
                item_table.setStyle(TableStyle([
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('PADDING', (0, 0), (-1, -1), 0),
                    ('RIGHTPADDING', (0, 0), (0, -1), 10),
                    ('BOTTOMPADDING', (1, 0), (1, -1), 2),
                    ('LEFTPADDING', (1, 0), (1, -1), 8),
                ]))
                story.append(item_table)

            story.append(Spacer(1, 10))

            # Render Photo Galleries (2x3 grid pages)
            gallery_photos = photos if (it_name.lower() != "location") else photos[1:]
            if gallery_photos:
                chunks = [gallery_photos[i:i + 6] for i in range(0, len(gallery_photos), 6)]
                for chunk in chunks:
                    story.append(PageBreak())
                    grid_rows = []
                    for row_i in range(0, len(chunk), 2):
                        p1 = chunk[row_i]
                        p2 = chunk[row_i + 1] if row_i + 1 < len(chunk) else None

                        f1 = process_image_to_flowable(p1.get('dataUrl'), max_width_pt=150.0, max_height_pt=195.0, border=True)
                        cap_text1 = (p1.get('caption') or "").replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                        cap1 = Paragraph(cap_text1, style_caption)

                        if p2:
                            f2 = process_image_to_flowable(p2.get('dataUrl'), max_width_pt=150.0, max_height_pt=195.0, border=True)
                            cap_text2 = (p2.get('caption') or "").replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                            cap2 = Paragraph(cap_text2, style_caption)
                        else:
                            f2 = Spacer(1, 195.0)
                            cap2 = Spacer(1, 10.0)

                        grid_rows.append([f1, f2])
                        grid_rows.append([cap1, cap2])
                        grid_rows.append([Spacer(1, 10.0), Spacer(1, 10.0)])

                    grid_table = Table(grid_rows, colWidths=[267.0, 267.0])
                    # Caption rows are at indices 1, 4, 7, ... (every 3n+1)
                    grid_style_cmds = [
                        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                        ('PADDING', (0, 0), (-1, -1), 0),
                    ]
                    for cap_row in range(1, len(grid_rows), 3):
                        grid_style_cmds.append(('BOTTOMPADDING', (0, cap_row), (-1, cap_row), 6))
                    grid_table.setStyle(TableStyle(grid_style_cmds))
                    story.append(grid_table)

        story.append(PageBreak())

    # ==========================================================================
    # GENERAL RECOMMENDATIONS (Fallback only if not present in sections)
    # ==========================================================================
    if not has_custom_general_recom:
        story.append(BookmarkFlowable("general_recom", "General Recommendations", level=0))
        story.append(Paragraph("General Recommendations", style_sec_title))

        story.append(make_gray_banner("1. Wall Repair Methodology", style_item_title))
        story.append(Spacer(1, 4))
        wall_recoms = [
            "<b>Hairline cracks, we recommend :</b>",
            "&nbsp;&nbsp;Step 1 : Sanding along the crack, then proper putty filling,",
            "&nbsp;&nbsp;Step 2 : Primer & paint finishing as per manufacture specification.",
            "<b>Significant cracks, we recommend :</b>",
            "&nbsp;&nbsp;Step 1 : Making 2 mm cutting along the crack with diamond bladed hand grinder",
            "&nbsp;&nbsp;Step 2 : Sanding off any loose materials and dirt",
            "&nbsp;&nbsp;Step 3 : Plastering with dry mesh and suitable grade cement mortar",
            "&nbsp;&nbsp;Step 4 : Primer & paint finishing as per manufacture specification.",
            "<b>Hollow plaster, we recommend :</b>",
            "&nbsp;&nbsp;Step 1 : Hollow plaster to be chipped off till hard surface",
            "&nbsp;&nbsp;Step 2 : Area to be re-plastered with suitable grade cement mortar"
        ]
        for r in wall_recoms:
            story.append(Paragraph(r, style_body))
            story.append(Spacer(1, 2))

        story.append(Spacer(1, 10))
        story.append(make_gray_banner("2. Waterproofing & Plumbing Maintenance", style_item_title))
        story.append(Spacer(1, 4))
        plumbing_recoms = [
            "• All bottle traps and angle valves with seepage should be dismantled, thread-taped, and refitted.",
            "• Pressure testing recommended for all concealed lines before completing civil touch-ups.",
            "• Maintain minimum 48-hour cure time for silicone sealant around counter tops and sanitary fittings."
        ]
        for r in plumbing_recoms:
            story.append(Paragraph(r, style_body))
            story.append(Spacer(1, 2))

        story.append(PageBreak())

    # ==========================================================================
    # REPORT SUMMARY (DEFICIENCY ROLLUP)
    # ==========================================================================
    story.append(BookmarkFlowable("report_summary", "Report Summary", level=0))
    story.append(Paragraph("Report Summary", style_sec_title))

    summary_intro = Paragraph(
        "The summary below consists of potentially significant findings. These findings can be a safety "
        "hazard, a deficiency requiring a major expense to correct or items I would like to draw extra attention "
        "to. The summary is not a complete listing of all the findings in the report, and reflects the opinion of "
        "the inspector. Please review all pages of the report as the summary alone does not explain all of the "
        "issues. All repairs should be done by a licensed & bonded tradesman or qualified professional. I "
        "recommend obtaining a copy of all receipts, warranties and permits for the work done.",
        style_body
    )
    story.append(summary_intro)
    story.append(Spacer(1, 10))

    if summary_findings:
        findings_by_sec = {}
        for f in summary_findings:
            findings_by_sec.setdefault(f['section'], []).append(f)

        for sec_name, sec_items in findings_by_sec.items():
            summary_table_data = []
            summary_table_data.append([
                Paragraph(f"<b>{sec_name}</b>", style_item_title), "", ""
            ])

            for f_item in sec_items:
                col1 = Paragraph(f"<b>Item: {f_item['item_index']}</b>", ParagraphStyle('SumItemIdx', fontName='Helvetica', fontSize=9.0, leading=11))
                col2 = Paragraph(f"<b>{f_item['item_name']}</b>", ParagraphStyle('SumItemName', fontName='Helvetica-Bold', fontSize=9.0, leading=11))
                clean_findings = [b.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;') for b in f_item['findings']]
                bullets_html = "<br/>".join([f"<font color=\"#ff0000\">• {b}</font>" for b in clean_findings])
                col3 = Paragraph(bullets_html, ParagraphStyle('SumFindings', fontName='Helvetica', fontSize=9.0, leading=12))
                summary_table_data.append([col1, col2, col3])

            sum_tbl = Table(summary_table_data, colWidths=[80.0, 110.0, 344.0])
            sum_tbl.setStyle(TableStyle([
                ('SPAN', (0, 0), (2, 0)),
                ('BACKGROUND', (0, 0), (2, 0), GRAY_BAR),
                ('BOX', (0, 0), (-1, -1), 0.75, BORDER_BLACK),
                ('INNERGRID', (0, 0), (-1, -1), 0.5, LIGHT_GRAY_LINE),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 5),
                ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ]))
            story.append(sum_tbl)
            story.append(Spacer(1, 10))
    else:
        story.append(Paragraph("<i>No critical defects or marginal conditions recorded in this inspection.</i>", style_body))

    # Build Document with Custom Canvas
    hip_canvas = HipReportCanvas
    def make_canvas(*args, **kwargs):
        c = hip_canvas(*args, **kwargs)
        c.set_header_info(company_name, prop_address)
        return c

    doc.build(story, canvasmaker=make_canvas)

    pdf_bytes = buffer.getvalue()
    buffer.close()
    return pdf_bytes
