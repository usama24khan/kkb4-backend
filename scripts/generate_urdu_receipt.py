#!/usr/bin/env python3
"""
generate_urdu_receipt.py
========================
Renders a payment-receipt PDF for KKB4 Housing Society in Urdu, with proper
Nastaliq shaping and right-to-left layout. Companion to generate_urdu_notice.py
— it shares the same font-resolution logic, dependencies (fpdf2 + uharfbuzz +
fonttools) and venv.

One receipt = one slip (no duplicate copy).

Invoked from the Node backend (receiptPdfGenerator.ts) as:

    python3 generate_urdu_receipt.py --file <payload.json>

Self-test (verify the pipeline independently of Node):

    python3 generate_urdu_receipt.py --self-test

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

PAGE_SIZE = "A5"          # 148 x 210 mm
PAGE_W = 148
PAGE_H = 210
MARGIN = 14               # mm, outer page margin
PAD = 9                   # mm, inner padding of the slip card
CARD_TOP = 18             # mm
CARD_H = 150              # mm

# Monochrome palette (matches the notice generator)
DARK      = (15,  23,  42)
SOFT_DARK = (51,  65,  85)
MUTED     = (100, 116, 139)
SUBTLE    = (148, 163, 184)
LINE_GREY = (203, 213, 225)
BAND_BG   = (248, 250, 252)
GREEN     = (5,   150, 105)


# ── Font resolution (identical strategy to generate_urdu_notice.py) ────────────

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


def has_non_latin(text: str) -> bool:
    return any(ord(c) > 127 for c in text or "")


# ── Renderer ───────────────────────────────────────────────────────────────────

class ReceiptPDF(FPDF):
    URDU  = "Urdu"
    LATIN = "Helvetica"

    def __init__(self, font_path: Path) -> None:
        super().__init__("P", "mm", PAGE_SIZE)
        self.set_auto_page_break(auto=False)
        self.set_margins(MARGIN, MARGIN, MARGIN)
        self.add_font(self.URDU, fname=str(font_path))
        self.set_text_shaping(True)

    def text_at(self, text: str, x: float, y: float, size: float,
                color: tuple[int, int, int] = DARK, *, urdu: bool = False,
                bold: bool = False, align: str = "L",
                width: float | None = None) -> None:
        if urdu:
            self.set_font(self.URDU, size=size)
        else:
            self.set_font(self.LATIN, "B" if bold else "", size=size)
        self.set_text_color(*color)
        if width is None:
            width = self.get_string_width(text)
        self.set_xy(x, y)
        self.cell(w=width, h=size * 0.5, text=text, align=align,
                  new_x="RIGHT", new_y="TOP")

    def auto_text(self, text: str, x: float, y: float, size: float,
                  color: tuple[int, int, int] = DARK, *, bold: bool = False,
                  align: str = "R", width: float | None = None) -> None:
        """Urdu font for non-Latin values, Latin otherwise."""
        self.text_at(text, x, y, size, color, urdu=has_non_latin(text),
                     bold=bold, align=align, width=width)

    def hline(self, x0: float, x1: float, y: float,
              color: tuple[int, int, int] = LINE_GREY, width: float = 0.3) -> None:
        self.set_draw_color(*color)
        self.set_line_width(width)
        self.line(x0, y, x1, y)

    def card(self, x: float, y: float, w: float, h: float) -> None:
        self.set_draw_color(*LINE_GREY)
        self.set_line_width(0.4)
        self.rect(x, y, w, h, style="D", round_corners=True, corner_radius=2.5)

    def band(self, x: float, y: float, w: float, h: float) -> None:
        self.set_fill_color(*BAND_BG)
        self.set_draw_color(*LINE_GREY)
        self.set_line_width(0.3)
        self.rect(x, y, w, h, style="DF")


def render(p: dict, font_path: Path) -> str:
    """Render the single RTL receipt slip."""
    out_path = p["outputPath"]
    pdf = ReceiptPDF(font_path)
    pdf.add_page()

    box_x = MARGIN
    box_w = PAGE_W - 2 * MARGIN
    # The card border is drawn at the end, once the content height is known.

    inner_l = box_x + PAD
    inner_r = box_x + box_w - PAD
    inner_w = inner_r - inner_l

    y = CARD_TOP + PAD

    # ── Header ──
    society = p.get("societyName") or "کے کے بی ہاؤسنگ سوسائٹی"
    pdf.set_font(pdf.URDU, size=15)
    sw = pdf.get_string_width(society)
    pdf.text_at(society, (PAGE_W - sw) / 2, y, 15, DARK, urdu=True, align="C", width=sw)
    y += 9
    subtitle = "ادائیگی کی رسید"
    pdf.set_font(pdf.URDU, size=10)
    sw2 = pdf.get_string_width(subtitle)
    pdf.text_at(subtitle, (PAGE_W - sw2) / 2, y, 10, MUTED, urdu=True, align="C", width=sw2)
    y += 9
    pdf.hline(inner_l, inner_r, y)
    y += 6

    # ── Two-column meta rows (RTL: right column first) ──
    col_gap = 8
    col_w = (inner_w - col_gap) / 2
    right_col_x = inner_r - col_w
    left_col_x = inner_l
    row_h = 15

    def field(label_ur: str, value: str, col_x: float, cy: float, w: float,
              value_urdu: bool | None = None) -> None:
        pdf.text_at(label_ur, col_x, cy, 8, SUBTLE, urdu=True, align="R", width=w)
        if value_urdu is True:
            pdf.text_at(value or "—", col_x, cy + 5, 11, DARK, urdu=True, align="R", width=w)
        elif value_urdu is False:
            pdf.text_at(value or "—", col_x, cy + 5, 11, DARK, bold=True, align="R", width=w)
        else:
            pdf.auto_text(value or "—", col_x, cy + 5, 11, DARK, bold=True, align="R", width=w)

    # Row 1: رسید نمبر (right) | تاریخ (left)
    field("رسید نمبر", p.get("receiptNumber", ""), right_col_x, y, col_w, value_urdu=False)
    field("تاریخ", p.get("date", ""), left_col_x, y, col_w, value_urdu=False)
    y += row_h

    # Row 2: بلاک نمبر (right) | پلاٹ نمبر (left)
    field("بلاک نمبر", p.get("blockNo", ""), right_col_x, y, col_w)
    field("پلاٹ نمبر", p.get("plotNo", ""), left_col_x, y, col_w)
    y += row_h

    # Row 3: مالک (owner) — full width
    field("مالک کا نام", p.get("ownerName", ""), inner_l, y, inner_w)
    y += row_h

    # Row 4: مہینہ (right) | سال (left)
    field("مہینہ", p.get("month", ""), right_col_x, y, col_w)
    field("سال", p.get("year", ""), left_col_x, y, col_w, value_urdu=False)
    y += row_h

    # Optional period (full width, Latin dates)
    if p.get("period"):
        field("دورانیہ", p.get("period", ""), inner_l, y, inner_w, value_urdu=False)
        y += row_h
    y += 3

    # ── Amount band ──
    band_h = 18
    pdf.band(inner_l, y, inner_w, band_h)
    pdf.text_at("موصول رقم", inner_r - 4, y + 3, 8, MUTED, urdu=True, align="R", width=40)
    amount = int(p.get("amount", 0) or 0)
    digits = f"{amount:,}/- "
    pdf.set_font(pdf.URDU, size=15)
    rupee_w = pdf.get_string_width("روپے")
    pdf.set_font(pdf.LATIN, "B", size=15)
    digits_w = pdf.get_string_width(digits)
    pdf.text_at("روپے", inner_r - 4 - rupee_w, y + 9, 15, DARK, urdu=True,
                align="R", width=rupee_w)
    pdf.text_at(digits, inner_r - 4 - rupee_w - digits_w, y + 9, 15, DARK, bold=True,
                align="R", width=digits_w)
    y += band_h + 6

    pdf.text_at("شکریہ کے ساتھ موصول ہوا۔", inner_r, y, 9, MUTED, urdu=True,
                align="R", width=inner_w)
    y += 8

    # ── Signature (single, society side) ──
    # Flows BELOW the amount section so it can never overlap the amount band.
    sig_w = 55
    sig_x = inner_l
    sig_top = y

    sig_path = p.get("signaturePath")
    if sig_path:
        img_w = 17  # mm
        img_h = img_w * (414 / 603)
        try:
            pdf.image(sig_path, x=sig_x + (sig_w - img_w) / 2, y=sig_top, w=img_w)
            line_y = sig_top + img_h + 1.5
        except Exception:
            line_y = sig_top + 12
    else:
        line_y = sig_top + 12

    pdf.hline(sig_x, sig_x + sig_w, line_y)
    pdf.text_at("مجاز دستخط", sig_x, line_y + 1.5, 8.5, MUTED, urdu=True,
                align="C", width=sig_w)
    pdf.text_at(society, sig_x, line_y + 7, 8, DARK, urdu=True, align="C", width=sig_w)

    # ── Card border (drawn last, sized to the actual content) ──
    card_bottom = line_y + 14
    pdf.card(box_x, CARD_TOP, box_w, card_bottom - CARD_TOP)

    pdf.output(out_path)
    return out_path


# ── Self-test ─────────────────────────────────────────────────────────────────

def run_self_test() -> int:
    out = Path(tempfile.gettempdir()) / "kkb4_urdu_receipt_selftest.pdf"
    payload = {
        "outputPath": str(out),
        "societyName": "کے کے بی ہاؤسنگ سوسائٹی",
        "receiptNumber": "KKB-2026-0001",
        "date": "07/06/2026",
        "blockNo": "A",
        "plotNo": "374",
        "ownerName": "محمد احمد خان",
        "month": "جنوری",
        "year": "2026",
        "amount": 262,
        "period": "01/01/2026 - 31/03/2026",
        "signaturePath": str(Path(__file__).resolve().parent.parent / "signature" / "signature.png"),
        "isVerified": True,
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
    parser = argparse.ArgumentParser(description="Render KKB4 Urdu receipt PDF.")
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
