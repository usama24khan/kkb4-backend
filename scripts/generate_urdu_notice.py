#!/usr/bin/env python3
"""
generate_urdu_notice.py
=======================
Renders a maintenance-notice PDF for KKB4 Housing Society in Urdu, with
proper Nastaliq shaping (initial / medial / final / isolated joining forms)
and right-to-left layout.

Invoked from the Node backend (pdfGenerator.ts) as:

    python3 generate_urdu_notice.py --file <payload.json>

Self-test (verify the pipeline independently of Node):

    python3 generate_urdu_notice.py --self-test

Rendering approach
------------------
fpdf2 + HarfBuzz (via uharfbuzz). HarfBuzz is the same OpenType shaping
engine used by Chrome and Pango — it consumes the font's GSUB/GPOS tables
and emits the correctly-joined Urdu glyphs. We can't use the simpler
ReportLab + arabic-reshaper combo here because modern Noto fonts removed
the legacy Arabic Presentation-Forms-B codepoints (U+FB50–FEFF) that
arabic-reshaper outputs, so those characters would render as blank glyphs.

Dependencies (install once):
    pip install fpdf2 uharfbuzz

Font:
    A STATIC Noto Nastaliq Urdu TTF is expected (variable fonts confuse
    fpdf2's subsetter). The script searches these locations in order:
      1. $URDU_FONT_PATH                                            (env var)
      2. <script_dir>/NotoNastaliqUrdu-Static.ttf
      3. <script_dir>/NotoNastaliqUrdu-Regular.ttf
      4. /usr/local/share/fonts/NotoNastaliqUrdu-Regular.ttf
      5. /usr/share/fonts/truetype/noto/NotoNastaliqUrdu-Regular.ttf
      6. ~/fonts/NotoNastaliqUrdu-Regular.ttf
      7. ~/Library/Fonts/NotoNastaliqUrdu-Regular.ttf               (macOS)
      8. ~/.local/share/fonts/NotoNastaliqUrdu-Regular.ttf          (Linux)

If only the variable font is on disk, the script flattens it to a static
instance at weight 400 on first run and caches the result alongside the
variable file. `npm run setup:urdu` does this for you.

Exit codes:
    0  success — outputPath printed on stdout
    1  any error — message printed to stderr, prefixed with DEPENDENCY_ERROR
       when a missing pip package or font is the cause.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

# ── Dependency imports (caught so Node gets a clean error message) ─────────────
try:
    from fpdf import FPDF
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
except ImportError as exc:  # pragma: no cover — bootstrap path
    sys.stderr.write(
        f"DEPENDENCY_ERROR: {exc}. Run: pip install fpdf2 uharfbuzz fonttools\n"
    )
    sys.exit(1)


# ── Constants ──────────────────────────────────────────────────────────────────

PAGE_SIZE = "A4"
MARGIN_L = 20   # mm
MARGIN_R = 20   # mm
MARGIN_T = 28   # mm
MARGIN_B = 22   # mm
MARGIN = MARGIN_L

# Monochrome palette
DARK       = (15,  23,  42)
SOFT_DARK  = (51,  65,  85)
MUTED      = (100, 116, 139)
SUBTLE     = (148, 163, 184)
LINE_GREY  = (210, 217, 227)
HEADER_BG  = (243, 245, 248)

URDU_MONTH = {
    "jan": "جنوری", "feb": "فروری", "mar": "مارچ", "apr": "اپریل",
    "may": "مئی",   "jun": "جون",   "jul": "جولائی","aug": "اگست",
    "sep": "ستمبر","oct": "اکتوبر","nov": "نومبر","dec": "دسمبر",
}

URDU_STATUS = {
    "Active":    "فعال",
    "Cancelled": "منسوخ",
    "Unsold":    "غیر فروخت",
    "Unknown":   "نامعلوم",
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def find_urdu_font() -> Path:
    """Resolve a usable static TTF. If only the variable file is found, flatten
    it to a static instance at weight 400 and cache the result."""
    here = Path(__file__).resolve().parent
    candidates: list[Path] = []
    env_path = os.environ.get("URDU_FONT_PATH")
    if env_path:
        candidates.append(Path(env_path).expanduser())

    candidates.extend([
        here / "NotoNastaliqUrdu-Static.ttf",
        here / "NotoNastaliqUrdu-Regular.ttf",
        here / "NotoNastaliqUrdu[wght].ttf",
        Path("/usr/local/share/fonts/NotoNastaliqUrdu-Regular.ttf"),
        Path("/usr/share/fonts/truetype/noto/NotoNastaliqUrdu-Regular.ttf"),
        Path.home() / "fonts" / "NotoNastaliqUrdu-Regular.ttf",
        Path.home() / "Library" / "Fonts" / "NotoNastaliqUrdu-Regular.ttf",
        Path.home() / ".local" / "share" / "fonts" / "NotoNastaliqUrdu-Regular.ttf",
    ])

    chosen: Path | None = None
    for p in candidates:
        if p.is_file():
            chosen = p
            break
    if not chosen:
        for ttf in here.glob("NotoNastaliqUrdu*.ttf"):
            if ttf.is_file():
                chosen = ttf
                break

    if not chosen:
        sys.stderr.write(
            "DEPENDENCY_ERROR: NotoNastaliqUrdu-Regular.ttf not found. "
            "Set $URDU_FONT_PATH or drop the TTF in one of: "
            f"{', '.join(str(c) for c in candidates)}\n"
        )
        sys.exit(1)

    f = TTFont(str(chosen))
    if "fvar" in f:
        static_path = chosen.parent / "NotoNastaliqUrdu-Static.ttf"
        if not static_path.is_file():
            try:
                static = instantiateVariableFont(f, {"wght": 400})
                static.save(str(static_path))
            except Exception as exc:
                sys.stderr.write(
                    f"DEPENDENCY_ERROR: Could not flatten variable font: {exc}\n"
                )
                sys.exit(1)
        return static_path

    return chosen


def urdu_unpaid_months(months: list[str]) -> str:
    if not months:
        return "—"
    if len(months) == 12:
        return "تمام 12 ماہ"
    return "، ".join(URDU_MONTH.get(m, m) for m in months)


def has_non_latin(text: str) -> bool:
    return any(ord(c) > 127 for c in text or "")


# ── Renderer ───────────────────────────────────────────────────────────────────

class NoticePDF(FPDF):
    URDU  = "Urdu"
    LATIN = "Helvetica"

    def __init__(self, font_path: Path) -> None:
        super().__init__("P", "mm", PAGE_SIZE)
        self.set_auto_page_break(auto=False)
        self.set_margins(MARGIN_L, MARGIN_T, MARGIN_R)
        self.add_font(self.URDU, fname=str(font_path))
        self.set_text_shaping(True)

    # Geometry helpers -------------------------------------------------------
    def right_x(self) -> float:
        return self.w - self.r_margin

    def left_x(self) -> float:
        return self.l_margin

    def content_w(self) -> float:
        return self.w - self.l_margin - self.r_margin

    # Drawing primitives -----------------------------------------------------
    def urdu_text_right(self, text: str, y: float, size: float,
                        color: tuple[int, int, int] = DARK) -> None:
        self.set_font(self.URDU, size=size)
        self.set_text_color(*color)
        w = self.get_string_width(text)
        self.set_xy(self.right_x() - w, y)
        self.cell(w=w, h=size * 0.5, text=text, align="R",
                  new_x="RIGHT", new_y="TOP")

    def urdu_text_center(self, text: str, y: float, size: float,
                         color: tuple[int, int, int] = DARK) -> None:
        self.set_font(self.URDU, size=size)
        self.set_text_color(*color)
        w = self.get_string_width(text)
        x = (self.w - w) / 2
        self.set_xy(x, y)
        self.cell(w=w, h=size * 0.5, text=text, align="C",
                  new_x="RIGHT", new_y="TOP")

    def latin_text_left(self, text: str, y: float, size: float,
                        color: tuple[int, int, int] = DARK,
                        bold: bool = False) -> None:
        self.set_font(self.LATIN, "B" if bold else "", size=size)
        self.set_text_color(*color)
        self.set_xy(self.left_x(), y)
        self.cell(w=self.content_w() / 2, h=size * 0.5, text=text,
                  align="L", new_x="RIGHT", new_y="TOP")

    def latin_text_at(self, text: str, x: float, y: float, size: float,
                      color: tuple[int, int, int] = DARK,
                      bold: bool = False, align: str = "L",
                      width: float | None = None) -> None:
        self.set_font(self.LATIN, "B" if bold else "", size=size)
        self.set_text_color(*color)
        if width is None:
            width = self.get_string_width(text)
        self.set_xy(x, y)
        self.cell(w=width, h=size * 0.5, text=text, align=align,
                  new_x="RIGHT", new_y="TOP")

    def latin_text_center(self, text: str, y: float, size: float,
                          color: tuple[int, int, int] = DARK,
                          bold: bool = False) -> None:
        self.set_font(self.LATIN, "B" if bold else "", size=size)
        self.set_text_color(*color)
        w = self.get_string_width(text)
        self.set_xy((self.w - w) / 2, y)
        self.cell(w=w, h=size * 0.5, text=text, align="C",
                  new_x="RIGHT", new_y="TOP")

    def urdu_text_at(self, text: str, x: float, y: float, size: float,
                     color: tuple[int, int, int] = DARK,
                     align: str = "R",
                     width: float | None = None) -> None:
        self.set_font(self.URDU, size=size)
        self.set_text_color(*color)
        if width is None:
            width = self.get_string_width(text)
        self.set_xy(x, y)
        self.cell(w=width, h=size * 0.5, text=text, align=align,
                  new_x="RIGHT", new_y="TOP")

    def hline(self, y: float, color: tuple[int, int, int] = LINE_GREY,
              width: float = 0.2) -> None:
        self.set_draw_color(*color)
        self.set_line_width(width)
        self.line(self.l_margin, y, self.right_x(), y)

    def filled_band(self, y: float, h: float,
                    color: tuple[int, int, int] = HEADER_BG) -> None:
        self.set_fill_color(*color)
        self.rect(self.l_margin, y, self.content_w(), h, style="F")

    def get_string_width_for(self, text: str, family: str, size: float) -> float:
        saved_family = self.font_family
        saved_style  = self.font_style
        saved_size   = self.font_size_pt
        name = self.URDU if family.lower() == "urdu" else self.LATIN
        self.set_font(name, size=size)
        w = self.get_string_width(text)
        self.set_font(saved_family, saved_style, size=saved_size)
        return w


def render(payload: dict, font_path: Path) -> str:
    """Render the notice with corrected masthead, table padding, and footer."""

    out_path = payload["outputPath"]
    pdf = NoticePDF(font_path)
    pdf.add_page()

    LH_URDU      = 7.5   # mm line-height for 11pt Urdu rows
    LABEL_VAL_GAP = 4    # mm gap between Urdu label and Latin value
    LABEL_WIDTH   = 50   # mm fixed-width label column

    # ── Masthead ──────────────────────────────────────────────────────────────
    # Row 1: Society name — large, centered, bold-weight via size
    y = MARGIN_T
    pdf.urdu_text_center("کے کے بی فیز 4 ہاؤسنگ سوسائٹی", y, 20, DARK)
    y += 16

  

    # Divider 1
    # pdf.hline(y, color=LINE_GREY, width=0.3)
    y += 5

    # Row 3: "ای میل: admin@kkb4.com" on RIGHT  |  "فون: <number>" on LEFT
    # Pull the phone number from the plot payload (fallback to empty string)
    phone = "03226576614"
    # Right side: label in Urdu + Latin email value
    email_label    = "ای میل:"
    email_value    = "admin@kkb4.com"
    email_label_w  = pdf.get_string_width_for(email_label, "urdu", 10)
    email_value_w  = pdf.get_string_width_for(email_value, "latin", 10)
    gap            = 2   # mm between Urdu label and Latin value
    # Draw email label (Urdu, right-anchored)
    pdf.urdu_text_right(email_label, y, 10, MUTED)
    # Draw email value immediately LEFT of the label
    pdf.latin_text_at(
        email_value,
        pdf.right_x() - email_label_w - gap - email_value_w,
        y, 10, MUTED, align="L", width=email_value_w,
    )
    # Left side: "فون:" label then phone number
    phone_label   = "فون:"
    phone_label_w = pdf.get_string_width_for(phone_label, "urdu", 10)
    phone_val_w   = pdf.get_string_width_for(phone or "—", "latin", 10)
    # Draw phone value at the left margin
    pdf.latin_text_at(phone or "—", pdf.left_x(), y, 10, MUTED,
                      align="L", width=phone_val_w)
    # Draw Urdu "فون:" label immediately right of the value
    pdf.urdu_text_at(phone_label,
                     pdf.left_x() + phone_val_w + gap, y,
                     10, MUTED, align="L", width=phone_label_w)
    y += 8

    # Divider 2
    pdf.hline(y, color=LINE_GREY, width=0.3)
    y += 10

    # ── Title — centered, larger, with underline drawn manually ───────────────
    title_text = "واجب الادا فیس نوٹس"
    title_size = 17
    pdf.set_font(pdf.URDU, size=title_size)
    title_w = pdf.get_string_width(title_text)
    title_x = (pdf.w - title_w) / 2
    pdf.urdu_text_center(title_text, y, title_size, DARK)
    # Underline: drawn 1 mm below the text baseline
    underline_y = y + title_size * 0.5 + 1.5
    pdf.set_draw_color(*DARK)
    pdf.set_line_width(0.4)
    pdf.line(title_x, underline_y, title_x + title_w, underline_y)
    y += title_size * 0.5 + 6   # comfortable gap before meta rows

    # ── Meta rows (label right, value immediately left of it) ─────────────────
    def meta_row(label_ur: str, value: str, y_pos: float) -> float:
        pdf.urdu_text_right(label_ur, y_pos, 11, SUBTLE)
        label_w      = pdf.get_string_width_for(label_ur, "urdu", 11)
        value_right_x = pdf.right_x() - label_w - LABEL_VAL_GAP
        value_w      = LABEL_WIDTH
        pdf.latin_text_at(value, value_right_x - value_w, y_pos, 11, DARK,
                          align="R", width=value_w)
        return y_pos + LH_URDU

    y = meta_row("نوٹس نمبر", str(payload.get("noticeNumber", "")), y)
    y = meta_row("تاریخ",     payload.get("date", ""),              y)
    y = meta_row("دورانیہ",   payload.get("yearLabel", ""),         y)
    y += 4

    # ── Owner block ───────────────────────────────────────────────────────────
    plot = payload.get("plot") or {}
    pdf.urdu_text_right("مالک کی تفصیلات", y, 12, SOFT_DARK)
    y += 8

    def owner_row(label_ur: str, value: str, y_pos: float,
                  value_is_urdu: bool = False) -> float:
        pdf.urdu_text_right(label_ur, y_pos, 11, SUBTLE)
        label_w       = pdf.get_string_width_for(label_ur, "urdu", 11)
        value_right_x = pdf.right_x() - label_w - LABEL_VAL_GAP
        value_w       = pdf.content_w() - label_w - LABEL_VAL_GAP - 2
        if value_is_urdu or has_non_latin(value):
            pdf.urdu_text_at(value, value_right_x - value_w, y_pos, 11,
                             DARK, align="R", width=value_w)
        else:
            pdf.latin_text_at(value, value_right_x - value_w, y_pos, 11,
                              DARK, align="R", width=value_w)
        return y_pos + LH_URDU

    if plot.get("ownerName"):
        y = owner_row("نام", plot["ownerName"], y)

    y = owner_row(
        "پلاٹ نمبر / بلاک / فیز",
        f"{plot.get('plotNumber', '?')} / {plot.get('block', '?')} / "
        f"{plot.get('phase') or '—'}",
        y,
    )

    if plot.get("ownerPhone"):
        y = owner_row("فون", plot["ownerPhone"], y)

    raw_status = plot.get("allotmentStatus") or "Unknown"
    status_ur  = URDU_STATUS.get(raw_status, raw_status)
    y = owner_row("حیثیت", status_ur, y, value_is_urdu=True)
    y += 6

    # ── Dues table ────────────────────────────────────────────────────────────
    pdf.urdu_text_right("واجب الادا بقایا", y, 12, SOFT_DARK)
    y += 6

    left      = pdf.left_x()
    total_w   = pdf.content_w()
    col_amount = 36
    col_rate   = 28
    col_year   = 22
    col_months = total_w - col_amount - col_rate - col_year
    col_x = [
        left,
        left + col_amount,
        left + col_amount + col_rate,
        left + col_amount + col_rate + col_months,
    ]
    col_w   = [col_amount, col_rate, col_months, col_year]
    headers = ["واجب رقم", "ماہانہ شرح", "بقایا مہینے", "سال"]

    # ── Table header band — taller with generous top+bottom padding ──
    HEADER_H   = 12          # was 8 — more vertical breathing room
    HEADER_PAD = 3.0         # mm top padding inside the band

    pdf.filled_band(y, HEADER_H, HEADER_BG)
    pdf.hline(y,            LINE_GREY, 0.3)
    pdf.hline(y + HEADER_H, LINE_GREY, 0.3)

    text_y = y + HEADER_PAD  # padded baseline inside the band
    for i, h in enumerate(headers):
        pdf.urdu_text_at(h, col_x[i], text_y, 10.5, SOFT_DARK,
                         align="C", width=col_w[i])
    y += HEADER_H + 2

    # ── Table data rows — more height per row ──
    breakdowns = payload.get("breakdowns") or []
    if not breakdowns:
        pdf.urdu_text_center("منتخب مدت کے لیے کوئی واجب الادا بقایا نہیں۔",
                             y + 6, 11, MUTED)
        y += 20
    else:
        ROW_H     = 11       # was 8 — taller rows, less cramped
        ROW_PAD   = 2.5      # mm top padding so text doesn't hug the divider

        for idx, row in enumerate(breakdowns):
            row_text_y = y + ROW_PAD

            pdf.latin_text_at(f"{row.get('amountDue', 0):,}", col_x[0],
                              row_text_y, 11, DARK, bold=True,
                              align="C", width=col_w[0])
            pdf.latin_text_at(f"{row.get('mcRate', 0):,}", col_x[1],
                              row_text_y, 11, DARK,
                              align="C", width=col_w[1])
            months = urdu_unpaid_months(row.get("unpaidMonths") or [])
            pdf.urdu_text_at(months, col_x[2], row_text_y, 10.5, DARK,
                             align="C", width=col_w[2])
            pdf.latin_text_at(str(row.get("year", "")), col_x[3],
                              row_text_y, 11, DARK,
                              align="C", width=col_w[3])
            y += ROW_H

            # Subtle row separator between rows (not after the last)
            if idx < len(breakdowns) - 1:
                pdf.hline(y - 0.5, LINE_GREY, 0.15)

            if y > pdf.h - MARGIN_B - 60:
                pdf.add_page()
                y = MARGIN_T

    pdf.hline(y, LINE_GREY, 0.3)
    y += 8   # extra space below the table bottom rule

    # ── Grand total ───────────────────────────────────────────────────────────
    grand = int(payload.get("grandTotal", 0))
    pdf.urdu_text_right("کل واجب الادا رقم", y, 12.5, DARK)
    pdf.set_font(pdf.LATIN, "B", size=12.5)
    digits   = f"{grand:,} "
    digits_w = pdf.get_string_width(digits)
    pdf.set_font(pdf.URDU, size=12.5)
    word     = "روپے"
    word_w   = pdf.get_string_width(word)
    pdf.latin_text_at(digits, pdf.left_x(), y, 12.5, DARK, bold=True,
                      align="L", width=digits_w)
    pdf.urdu_text_at(word, pdf.left_x() + digits_w, y, 12.5, DARK,
                     align="L", width=word_w)
    y += 13  # comfortable gap after grand total

    # ── Deadline ──────────────────────────────────────────────────────────────
    if payload.get("paymentDeadline"):
        pdf.urdu_text_right("براہ کرم تمام بقایا اس تاریخ تک ادا کریں:", y, 11, DARK)
        pdf.latin_text_at(payload["paymentDeadline"], pdf.left_x(), y, 11,
                          DARK, bold=True, align="L", width=40)
        y += 12
     
    else:
        y += 8

    # ── Payment instructions ──────────────────────────────────────────────────
    pdf.urdu_text_right("ادائیگی کی ہدایات", y, 12, SOFT_DARK)
    y += 8
    pdf.urdu_text_right(
        "براہ کرم اپنی مینٹیننس فیس کے کے بی 4 سوسائٹی آفس میں جمع کروائیں۔",
        y, 11, DARK,
    )
    y += 16
  

    # ── Signature block — ample spacing above line and between text lines ──────
    # Push the block to the bottom-right; ensure at least 30 mm clearance.
    sig_y = max(y + 8, pdf.h - MARGIN_B - 34)
    sig_w = 72
    sig_x = pdf.right_x() - sig_w

    # Signature rule
    pdf.set_draw_color(*DARK)
    pdf.set_line_width(0.3)
    pdf.line(sig_x, sig_y, pdf.right_x(), sig_y)

    # Gap between rule and first label
    sig_y += 7             # was 4 — more breathing room below the line

    pdf.urdu_text_at("سیکریٹری / چیئرمین", sig_x, sig_y, 10, DARK,
                     align="R", width=sig_w)

  

    pdf.output(out_path)
    return out_path


# ── Self-test ─────────────────────────────────────────────────────────────────

def run_self_test() -> int:
    out = Path(tempfile.gettempdir()) / "kkb4_urdu_selftest.pdf"
    payload = {
        "outputPath": str(out),
        "noticeNumber": 1,
        "yearLabel": "2024-2026",
        "date": "02/06/2026",
        "paymentDeadline": "17/06/2026",
        "plot": {
            "ownerName": "محمد احمد خان",
            "plotNumber": "374",
            "block": "A",
            "phase": "Phase 6",
            "ownerPhone": "0300-1234567",
            "allotmentStatus": "Active",
        },
        "breakdowns": [
            {"year": 2024, "mcRate": 400, "unpaidMonths": ["mar","jun","sep","dec"], "amountDue": 1600},
            {"year": 2025, "mcRate": 400, "unpaidMonths": ["jan","feb","mar","apr","may","jun"], "amountDue": 2400},
            {"year": 2026, "mcRate": 400, "unpaidMonths": ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"], "amountDue": 4800},
        ],
        "grandTotal": 8800,
    }
    try:
        font = find_urdu_font()
    except SystemExit as exc:
        return int(exc.code or 1)
    try:
        result = render(payload, font)
    except Exception as exc:
        sys.stderr.write(f"Render error: {exc}\n")
        return 1
    sys.stdout.write(f"OK: {result}\n  Font: {font}\n")
    return 0


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Render KKB4 Urdu notice PDF.")
    parser.add_argument("--file",      help="Path to JSON payload.")
    parser.add_argument("--self-test", action="store_true",
                        help="Run a synthetic render to verify the pipeline.")
    args = parser.parse_args()

    if args.self_test:
        sys.exit(run_self_test())

    if not args.file:
        sys.stderr.write("Either --file <payload.json> or --self-test is required.\n")
        sys.exit(2)

    try:
        with open(args.file, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"Failed to read payload: {exc}\n")
        sys.exit(1)

    try:
        font_path = find_urdu_font()
        out_path  = render(payload, font_path)
    except SystemExit:
        raise
    except Exception as exc:
        sys.stderr.write(f"Render error: {exc}\n")
        sys.exit(1)

    sys.stdout.write(out_path)


if __name__ == "__main__":
    main()