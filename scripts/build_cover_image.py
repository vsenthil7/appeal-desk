"""
Build the Appeal-Desk submission cover image for the Reddit Developer
Platform hackathon (AT-Hack0022).

Produces three variants:
  - cover-square-1200x1200.png   (App Directory thumbnail / social square)
  - cover-banner-1600x900.png    (16:9 hero banner for the deck and README)
  - cover-og-1200x630.png        (Open Graph / Twitter card)

All three share the same design language as the pitch deck:
  - Navy #0c1a2b background (authority, due-process)
  - Cream #f5efe3 primary text (humane, civil tone)
  - Slate #6b7a8f secondary text
  - Verdigris #4caf7d accent (overturned / approved decisions)
  - Coral #e26464 quiet accent for upheld decisions
  - Massive Appeal-Desk wordmark (auto-fit to canvas width)
  - Editorial subtitle
  - Top-strip "AT-HACK0022 \u00b7 REDDIT DEV PLATFORM 2026" marker
  - Bottom footer with repo URL

Pure Pillow -- uses Segoe UI / Arial fallbacks shipped with Windows.
Ported from the ATRIO submission pipeline (atrio/scripts/build_cover_image.py).
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


# ---------- Brand ----------
NAVY = (0x0C, 0x1A, 0x2B)            # background
CREAM = (0xF5, 0xEF, 0xE3)           # primary text
TEXT_PRIMARY = (0xE5, 0xDF, 0xD3)
TEXT_SECONDARY = (0x9B, 0xA8, 0xBA)
VERDIGRIS = (0x4C, 0xAF, 0x7D)       # accent: overturned / approved
CORAL = (0xE2, 0x64, 0x64)           # accent: upheld
SLATE = (0x6B, 0x7A, 0x8F)


def _load_font(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    if weight == "bold":
        candidates = [
            "C:/Windows/Fonts/Inter-Bold.ttf",
            "C:/Windows/Fonts/segoeuib.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
        ]
    elif weight == "italic":
        candidates = [
            "C:/Windows/Fonts/Inter-Italic.ttf",
            "C:/Windows/Fonts/segoeuii.ttf",
            "C:/Windows/Fonts/ariali.ttf",
        ]
    else:
        candidates = [
            "C:/Windows/Fonts/Inter-Regular.ttf",
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size=size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def _text_w(draw: ImageDraw.ImageDraw, text: str, font) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def _font_full_height(font: ImageFont.FreeTypeFont) -> int:
    ascent, descent = font.getmetrics()
    return ascent + descent


def _fit_font(draw, text: str, target_width: int, max_size: int, weight: str = "bold"):
    size = max_size
    while size > 20:
        font = _load_font(size, weight=weight)
        w = _text_w(draw, text, font)
        if w <= target_width:
            return font, size
        size -= 8
    return _load_font(20, weight=weight), 20


def make_cover(width: int, height: int, layout: str = "square") -> Image.Image:
    img = Image.new("RGB", (width, height), NAVY)
    draw = ImageDraw.Draw(img)
    margin = max(40, width // 30)

    # ---------- Top strip ----------
    tick_w = max(28, width // 50)
    tick_h = max(6, height // 200)
    draw.rectangle([margin, margin, margin + tick_w, margin + tick_h], fill=VERDIGRIS)
    label_font = _load_font(max(14, width // 80))
    draw.text(
        (margin + tick_w + 12, margin - 4),
        "AT-HACK0022  \u00b7  REDDIT DEV PLATFORM 2026",
        fill=TEXT_SECONDARY,
        font=label_font,
    )

    # ---------- Title sizing ----------
    wordmark = "APPEAL-DESK"
    if layout == "square":
        title_area_w = width - 2 * margin
        max_title_size = int(width * 0.18)
        title_y = int(height * 0.20)
    elif layout == "banner":
        title_area_w = int(width * 0.55) - margin
        max_title_size = int(height * 0.30)
        title_y = int(height * 0.20)
    else:  # og
        title_area_w = int(width * 0.55) - margin
        max_title_size = int(height * 0.32)
        title_y = int(height * 0.18)

    title_font, title_size = _fit_font(draw, wordmark, title_area_w, max_title_size, "bold")
    title_full_h = _font_full_height(title_font)
    title_w = _text_w(draw, wordmark, title_font)
    title_x = margin

    draw.text((title_x, title_y), wordmark, fill=CREAM, font=title_font)
    bottom_of_title = title_y + title_full_h

    # ---------- Verdigris underline ----------
    underline_gap = max(16, title_size // 18)
    underline_h = max(6, title_size // 50)
    underline_w = max(80, title_w // 4)
    underline_y = bottom_of_title + underline_gap
    draw.rectangle(
        [title_x, underline_y, title_x + underline_w, underline_y + underline_h],
        fill=VERDIGRIS,
    )

    # ---------- Subtitle ----------
    subtitle = "A fair appeals desk for modteams."
    sub_max = title_size // 3
    sub_font, sub_size = _fit_font(draw, subtitle, title_area_w, sub_max, "italic")
    sub_full_h = _font_full_height(sub_font)
    sub_gap = max(24, title_size // 12)
    sub_y = underline_y + underline_h + sub_gap
    draw.text((title_x, sub_y), subtitle, fill=CREAM, font=sub_font)
    bottom_of_sub = sub_y + sub_full_h

    # ---------- Tagline ----------
    # Square has room for 2 lines; banner + og are too short, so 1 line only.
    if layout == "square":
        tagline_lines = [
            "Structured intake \u00b7 audit-trail \u00b7 one-tap decisions.",
            "AI is assistive only -- the mod decides.",
        ]
    else:
        tagline_lines = [
            "Structured intake, audit-trail, one-tap decisions.",
        ]
    tagline_max = max(20, sub_size // 2)
    tagline_font, tagline_size = _fit_font(
        draw, max(tagline_lines, key=len), title_area_w, tagline_max, weight="regular"
    )
    line_height = int(_font_full_height(tagline_font) * 1.35)
    tagline_y = bottom_of_sub + max(28, sub_size // 4)
    # Footer takes up a band at the bottom -- make sure the tagline doesn't bleed into it.
    footer_font = _load_font(max(12, width // 100))
    footer_h = _font_full_height(footer_font)
    bottom_safe = height - margin - footer_h - max(20, height // 40)
    needed_h = line_height * len(tagline_lines)
    if tagline_y + needed_h > bottom_safe:
        # Shift tagline up so its last line ends at bottom_safe
        tagline_y = bottom_safe - needed_h
    for i, line in enumerate(tagline_lines):
        draw.text(
            (title_x, tagline_y + i * line_height),
            line,
            fill=TEXT_PRIMARY,
            font=tagline_font,
        )

    # ---------- Footer ----------
    footer_text = "github.com/vsenthil7/appeal-desk   \u00b7   MIT"
    draw.text(
        (margin, height - margin - footer_h),
        footer_text,
        fill=TEXT_SECONDARY,
        font=footer_font,
    )

    # ---------- KPI grid (banner + og only) ----------
    if layout in ("banner", "og"):
        right_x = int(width * 0.60)
        kpis = [
            ("288", "tests pass"),
            ("99.97%", "line coverage"),
            ("4", "build commits"),
            ("0", "AI required for MVP"),
        ]
        cell_w = (width - right_x - margin) // 2
        cell_h = (height - int(height * 0.30) - int(margin * 2)) // 2

        kpi_size = max(28, height // 6)
        while kpi_size > 24:
            kpi_font = _load_font(kpi_size, weight="bold")
            longest = max(_text_w(draw, big, kpi_font) for big, _ in kpis)
            if longest <= cell_w - 24:
                break
            kpi_size -= 4
        kpi_font = _load_font(kpi_size, weight="bold")
        small_font = _load_font(max(11, height // 55))

        kpi_top_y = int(height * 0.27)
        for i, (big, small) in enumerate(kpis):
            col = i % 2
            row = i // 2
            bx = right_x + col * (cell_w + 14)
            by = kpi_top_y + row * (cell_h + 14)
            draw.rectangle([bx, by, bx + cell_w, by + cell_h], outline=VERDIGRIS, width=3)
            bw = _text_w(draw, big, kpi_font)
            bh = _font_full_height(kpi_font)
            draw.text(
                (bx + (cell_w - bw) // 2, by + (cell_h - bh) // 2 - cell_h // 12),
                big,
                fill=CREAM,
                font=kpi_font,
            )
            sw = _text_w(draw, small, small_font)
            sh = _font_full_height(small_font)
            draw.text(
                (bx + (cell_w - sw) // 2, by + cell_h - sh - 14),
                small,
                fill=TEXT_SECONDARY,
                font=small_font,
            )

    return img


def make_icon(size: int = 512) -> Image.Image:
    """Square app-directory icon: navy field, verdigris underline, AD monogram."""
    img = Image.new("RGB", (size, size), NAVY)
    draw = ImageDraw.Draw(img)

    # Monogram: "A" stacked above "D" with the underline as the separating bar.
    margin = size // 8
    inner_w = size - 2 * margin
    # Big bold monogram fills most of the canvas
    mono_font, _ = _fit_font(draw, "AD", inner_w, int(size * 0.62), "bold")
    mono_w = _text_w(draw, "AD", mono_font)
    mono_h = _font_full_height(mono_font)
    mono_x = (size - mono_w) // 2
    mono_y = (size - mono_h) // 2 - size // 20
    draw.text((mono_x, mono_y), "AD", fill=CREAM, font=mono_font)

    # Verdigris underline beneath the monogram
    bar_w = int(mono_w * 0.65)
    bar_h = max(8, size // 64)
    bar_x = (size - bar_w) // 2
    bar_y = mono_y + mono_h + size // 32
    draw.rectangle([bar_x, bar_y, bar_x + bar_w, bar_y + bar_h], fill=VERDIGRIS)

    return img


def main():
    out_dir = Path(__file__).resolve().parent.parent / "submission_media"
    out_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = Path(__file__).resolve().parent.parent / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    variants = [
        ("cover-square-1200x1200.png", 1200, 1200, "square"),
        ("cover-banner-1600x900.png",  1600, 900,  "banner"),
        ("cover-og-1200x630.png",      1200, 630,  "og"),
    ]
    for name, w, h, layout in variants:
        img = make_cover(w, h, layout)
        out = out_dir / name
        img.save(out, "PNG", optimize=True)
        kb = out.stat().st_size // 1024
        print(f"  {name}: {w}x{h}  ({kb} KB)")
    # Also emit a 512x512 app icon into assets/ for the Devvit upload.
    icon = make_icon(512)
    icon_out = assets_dir / "icon.png"
    icon.save(icon_out, "PNG", optimize=True)
    kb = icon_out.stat().st_size // 1024
    print(f"  assets/icon.png: 512x512  ({kb} KB)")
    print(f"cover images -> {out_dir}")
    print(f"icon         -> {assets_dir}")


if __name__ == "__main__":
    main()
