"""Render the Appeal-Desk judge test script Markdown to a brand-consistent PDF.

Reads `submission_media/JUDGE_TEST_SCRIPT.md` and produces a multi-page PDF in
the same brand palette as the pitch deck (navy/cream/verdigris/coral). Uses
reportlab with a custom paragraph stylesheet -- pure Python, no headless
browser, no LibreOffice.

Ported from atrio/scripts/build_judge_script_pdf.py with palette + footer
adjusted for Appeal-Desk; the Markdown parser is unchanged.
"""
from __future__ import annotations

import re
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


# Brand palette -- print-friendly variants of the deck colours.
# Body uses dark ink on paper; accents use the on-screen navy/verdigris/coral.
INK = HexColor("#0c1a2b")        # navy (used for body text + heading underlines)
PAPER = HexColor("#ffffff")
PAPER_BG = HexColor("#fafaf7")
RULE = HexColor("#9ba8ba")
SUB = HexColor("#525252")
VERDIGRIS = HexColor("#4caf7d")
CORAL = HexColor("#e26464")
BLUE = HexColor("#5e8bd4")


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    s: dict[str, ParagraphStyle] = {}

    s["title"] = ParagraphStyle(
        "title",
        parent=base["Normal"],
        fontName="Times-Bold",
        fontSize=24,
        leading=28,
        textColor=INK,
        spaceBefore=0,
        spaceAfter=4,
    )
    s["subtitle"] = ParagraphStyle(
        "subtitle",
        parent=base["Normal"],
        fontName="Times-Italic",
        fontSize=11,
        leading=14,
        textColor=SUB,
        spaceAfter=10,
    )
    s["byline"] = ParagraphStyle(
        "byline",
        parent=base["Normal"],
        fontName="Helvetica",
        fontSize=8,
        leading=10,
        textColor=SUB,
        spaceAfter=6,
        alignment=TA_LEFT,
    )
    s["h1"] = ParagraphStyle(
        "h1",
        parent=base["Normal"],
        fontName="Times-Bold",
        fontSize=14,
        leading=18,
        textColor=INK,
        spaceBefore=14,
        spaceAfter=4,
    )
    s["h2"] = ParagraphStyle(
        "h2",
        parent=base["Normal"],
        fontName="Times-Bold",
        fontSize=11,
        leading=14,
        textColor=INK,
        spaceBefore=10,
        spaceAfter=3,
    )
    s["body"] = ParagraphStyle(
        "body",
        parent=base["Normal"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=13,
        textColor=INK,
        spaceAfter=5,
        alignment=TA_LEFT,
    )
    s["bullet"] = ParagraphStyle(
        "bullet",
        parent=s["body"],
        leftIndent=14,
        bulletIndent=2,
        spaceAfter=2,
    )
    s["quote"] = ParagraphStyle(
        "quote",
        parent=s["body"],
        fontName="Times-Italic",
        textColor=SUB,
        leftIndent=14,
        rightIndent=8,
        borderColor=RULE,
        borderPadding=(4, 6, 4, 6),
        borderWidth=0,
        leading=12,
    )
    s["code"] = ParagraphStyle(
        "code",
        parent=base["Code"],
        fontName="Courier",
        fontSize=8,
        leading=11,
        textColor=INK,
        backColor=HexColor("#eff1ef"),
        borderPadding=(4, 6, 4, 6),
        leftIndent=8,
        spaceAfter=6,
        spaceBefore=4,
    )
    return s


def _markdown_inline(text: str) -> str:
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"`([^`]+)`", r'<font face="Courier" backColor="#eff1ef">\1</font>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"\*([^*]+)\*", r"<i>\1</i>", text)
    return text


def _draw_page_furniture(canvas, doc):
    canvas.saveState()
    # Top verdigris tick
    canvas.setFillColor(VERDIGRIS)
    canvas.rect(20 * mm, doc.pagesize[1] - 18 * mm, 14 * mm, 2 * mm, fill=1, stroke=0)
    canvas.setFillColor(SUB)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(
        38 * mm,
        doc.pagesize[1] - 17 * mm,
        "AT-HACK0022 \u00b7 REDDIT DEV PLATFORM 2026 \u00b7 APPEAL-DESK",
    )
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.3)
    canvas.line(20 * mm, 14 * mm, doc.pagesize[0] - 20 * mm, 14 * mm)
    canvas.setFillColor(SUB)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(20 * mm, 10 * mm, "github.com/vsenthil7/appeal-desk   \u00b7   MIT")
    canvas.drawRightString(doc.pagesize[0] - 20 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


def _parse_markdown(md: str, styles: dict[str, ParagraphStyle]) -> list:
    flowables: list = []
    lines = md.splitlines()
    i = 0
    in_code = False
    code_buf: list[str] = []
    table_buf: list[list[str]] = []

    def flush_code():
        nonlocal code_buf
        if code_buf:
            txt = "<br/>".join(
                l.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                for l in code_buf
            )
            flowables.append(Paragraph(txt, styles["code"]))
            code_buf = []

    def flush_table():
        nonlocal table_buf
        if not table_buf:
            return
        if len(table_buf) < 2:
            table_buf = []
            return
        header = table_buf[0]
        rows = table_buf[2:] if len(table_buf) > 2 else []
        data = [header] + rows
        rendered = []
        for r, row in enumerate(data):
            rendered_row = []
            cell_style = styles["body"] if r > 0 else ParagraphStyle(
                "th", parent=styles["body"], fontName="Helvetica-Bold", textColor=PAPER
            )
            for cell in row:
                rendered_row.append(Paragraph(_markdown_inline(cell), cell_style))
            rendered.append(rendered_row)
        usable = A4[0] - 40 * mm
        n = max(1, len(header))
        col_w = [usable / n] * n
        t = Table(rendered, colWidths=col_w)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), INK),
            ("TEXTCOLOR", (0, 0), (-1, 0), PAPER),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, 0), 0.5, INK),
            ("LINEBELOW", (0, -1), (-1, -1), 0.5, RULE),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [PAPER, HexColor("#f7f7f0")]),
        ]))
        flowables.append(t)
        flowables.append(Spacer(1, 6))
        table_buf = []

    while i < len(lines):
        line = lines[i]
        stripped = line.rstrip()

        if stripped.startswith("```"):
            if in_code:
                flush_code()
                in_code = False
            else:
                flush_table()
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue

        if "|" in line and stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            table_buf.append(cells)
            i += 1
            continue
        else:
            flush_table()

        if stripped.startswith("# "):
            flowables.append(Paragraph(_markdown_inline(stripped[2:]), styles["title"]))
            i += 1
            continue
        if stripped.startswith("## "):
            flowables.append(Paragraph(_markdown_inline(stripped[3:]), styles["h1"]))
            i += 1
            continue
        if stripped.startswith("### "):
            flowables.append(Paragraph(_markdown_inline(stripped[4:]), styles["h2"]))
            i += 1
            continue

        if stripped == "---":
            flowables.append(Spacer(1, 4))
            flowables.append(HRFlowable(width="100%", thickness=0.5, color=RULE))
            flowables.append(Spacer(1, 4))
            i += 1
            continue

        if stripped.startswith(">"):
            txt = stripped.lstrip("> ").strip()
            flowables.append(Paragraph(_markdown_inline(txt), styles["quote"]))
            i += 1
            continue

        if stripped.startswith("- ") or stripped.startswith("* "):
            txt = stripped[2:]
            flowables.append(
                Paragraph(
                    f"<bullet>&bull;</bullet>{_markdown_inline(txt)}",
                    styles["bullet"],
                )
            )
            i += 1
            continue
        m = re.match(r"^(\d+)\.\s+(.*)$", stripped)
        if m:
            num, txt = m.groups()
            flowables.append(
                Paragraph(
                    f"<bullet>{num}.</bullet>{_markdown_inline(txt)}",
                    styles["bullet"],
                )
            )
            i += 1
            continue

        if not stripped:
            flowables.append(Spacer(1, 4))
            i += 1
            continue

        flowables.append(Paragraph(_markdown_inline(stripped), styles["body"]))
        i += 1

    flush_code()
    flush_table()
    return flowables


def build_pdf(input_md: Path, output_pdf: Path) -> None:
    md = input_md.read_text(encoding="utf-8")
    styles = _styles()

    doc = SimpleDocTemplate(
        str(output_pdf),
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=25 * mm,
        bottomMargin=20 * mm,
        title="Appeal-Desk -- Judge Test Script",
        author="vsenthil7",
        subject="Reddit Developer Platform Hackathon 2026 -- AT-Hack0022",
    )

    flowables = _parse_markdown(md, styles)

    doc.build(
        flowables,
        onFirstPage=_draw_page_furniture,
        onLaterPages=_draw_page_furniture,
    )

    size_kb = output_pdf.stat().st_size // 1024
    print(f"  judge test script PDF: {output_pdf.name}  ({size_kb} KB)")


def main():
    root = Path(__file__).resolve().parent.parent
    input_md = root / "submission_media" / "JUDGE_TEST_SCRIPT.md"
    output_pdf = root / "submission_media" / "JUDGE_TEST_SCRIPT.pdf"

    if not input_md.exists():
        raise SystemExit(f"missing input: {input_md}")

    build_pdf(input_md, output_pdf)
    print(f"  ->  {output_pdf}")


if __name__ == "__main__":
    main()
