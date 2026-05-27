"""
Generate the 7 storyboard frames for the Appeal-Desk demo video.

Each frame is a 1920x1080 PNG rendered in the same brand palette as the deck
(navy / cream / verdigris / coral). The frames depict the AppealDesk user
journey end-to-end:

  01_title           -- AppealDesk wordmark + tagline
  02_problem         -- The modmail-only status quo
  03_action_snapshot -- Mod bans -> action snapshot captured
  04_intake_form     -- Banned user fills the structured form
  05_dashboard       -- Mod opens the appeals dashboard
  06_reply_confirm   -- Reply-confirm form before send
  07_audit_outro     -- Audit trail + numbers + outro

A subsequent ffmpeg step assembles these into a <=60 second MP4 with
crossfades. Pure Pillow -- no headless browser, no playwright.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------- Brand ----------
NAVY = (0x0C, 0x1A, 0x2B)
CREAM = (0xF5, 0xEF, 0xE3)
TEXT_PRIMARY = (0xE5, 0xDF, 0xD3)
TEXT_SECONDARY = (0x9B, 0xA8, 0xBA)
VERDIGRIS = (0x4C, 0xAF, 0x7D)
CORAL = (0xE2, 0x64, 0x64)
BLUE = (0x5E, 0x8B, 0xD4)
PANEL = (0x14, 0x26, 0x3E)

W, H = 1920, 1080
MARGIN = 80


def _font(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
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
    elif weight == "mono":
        candidates = [
            "C:/Windows/Fonts/consola.ttf",
            "C:/Windows/Fonts/cour.ttf",
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


def _draw_top_strip(draw: ImageDraw.ImageDraw):
    draw.rectangle([MARGIN, MARGIN, MARGIN + 60, MARGIN + 8], fill=VERDIGRIS)
    draw.text(
        (MARGIN + 80, MARGIN - 6),
        "AT-HACK0022  \u00b7  REDDIT DEV PLATFORM 2026  \u00b7  APPEAL-DESK",
        fill=TEXT_SECONDARY,
        font=_font(18),
    )


def _draw_caption(draw: ImageDraw.ImageDraw, num: int, total: int, caption: str):
    """Bottom caption strip with frame counter."""
    y = H - 80
    draw.text((MARGIN, y), caption, fill=TEXT_SECONDARY, font=_font(20, "italic"))
    draw.text(
        (W - MARGIN - 100, y),
        f"{num} / {total}",
        fill=TEXT_SECONDARY,
        font=_font(20),
    )


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    lines: list[str] = []
    for raw in text.split("\n"):
        words = raw.split(" ")
        cur = ""
        for w in words:
            test = (cur + " " + w).strip()
            if draw.textbbox((0, 0), test, font=font)[2] <= max_w:
                cur = test
            else:
                if cur:
                    lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
    return lines


def _new(bg=NAVY) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(img)
    _draw_top_strip(draw)
    return img, draw


# ---------- Frames ----------


def frame_01_title(path: Path):
    img, draw = _new()
    # Massive wordmark
    f = _font(180, "bold")
    text = "APPEAL-DESK"
    w = draw.textbbox((0, 0), text, font=f)[2]
    draw.text((MARGIN, 320), text, fill=CREAM, font=f)
    # Verdigris underline
    draw.rectangle([MARGIN, 530, MARGIN + 240, 542], fill=VERDIGRIS)
    # Subtitle
    draw.text((MARGIN, 580), "A fair appeals desk for modteams.",
              fill=CREAM, font=_font(64, "italic"))
    draw.text((MARGIN, 700),
              "Structured intake  \u00b7  Audit trail  \u00b7  One-tap decisions  \u00b7  Civil replies.",
              fill=TEXT_PRIMARY, font=_font(34))
    draw.text((MARGIN, 920), "github.com/vsenthil7/appeal-desk",
              fill=VERDIGRIS, font=_font(26, "mono"))
    _draw_caption(draw, 1, 7, "Appeal-Desk \u2014 a fair appeals desk for modteams.")
    img.save(path, "PNG", optimize=True)


def frame_02_problem(path: Path):
    img, draw = _new()
    draw.text((MARGIN, 150), "The problem", fill=VERDIGRIS, font=_font(28, "bold"))
    draw.text((MARGIN, 200), "Appeals live in modmail.",
              fill=CREAM, font=_font(96, "bold"))
    draw.text((MARGIN, 330), "Justice doesn't scale that way.",
              fill=CREAM, font=_font(64, "italic"))

    bullets = [
        ("\u2715", "Unstructured walls of text \u2014 no link to the action"),
        ("\u2715", "No history \u2014 the same user can re-appeal 6 times"),
        ("\u2715", "No audit trail \u2014 \"why did we uphold this?\" is unanswerable a month later"),
        ("\u2715", "No civility scaffold \u2014 replies drafted from scratch, under pressure"),
    ]
    y = 540
    for mark, line in bullets:
        draw.text((MARGIN, y), mark, fill=CORAL, font=_font(40, "bold"))
        draw.text((MARGIN + 60, y + 5), line, fill=TEXT_PRIMARY, font=_font(34))
        y += 80

    _draw_caption(draw, 2, 7, "Appeals in modmail \u2014 inconsistent, opaque, exhausting.")
    img.save(path, "PNG", optimize=True)


def frame_03_action_snapshot(path: Path):
    img, draw = _new()
    draw.text((MARGIN, 150), "Step 1 \u2014 Action snapshot", fill=VERDIGRIS, font=_font(28, "bold"))
    draw.text((MARGIN, 200), "A ban is captured the moment it happens.",
              fill=CREAM, font=_font(64, "bold"))

    # Mock ModAction "card"
    card_x, card_y, card_w, card_h = MARGIN, 380, 1300, 560
    draw.rectangle([card_x, card_y, card_x + card_w, card_y + card_h],
                   fill=PANEL, outline=VERDIGRIS, width=3)
    draw.text((card_x + 40, card_y + 30),
              "EVENT  \u00b7  ModAction",
              fill=VERDIGRIS, font=_font(24, "bold"))
    draw.text((card_x + 40, card_y + 80),
              "type:        ban_user",
              fill=CREAM, font=_font(30, "mono"))
    draw.text((card_x + 40, card_y + 130),
              "target:      t2_a1b2c3d4",
              fill=CREAM, font=_font(30, "mono"))
    draw.text((card_x + 40, card_y + 180),
              "subreddit:   r/appeal_desk_dev",
              fill=CREAM, font=_font(30, "mono"))
    draw.text((card_x + 40, card_y + 230),
              "reason:      \"Breaking rule 3 \u2014 personal attacks\"",
              fill=CREAM, font=_font(28, "mono"))
    draw.text((card_x + 40, card_y + 310),
              "\u2192  action snapshot stored at",
              fill=TEXT_SECONDARY, font=_font(26))
    draw.text((card_x + 40, card_y + 350),
              "    actionseed:appeal_desk_dev:t2_a1b2c3d4",
              fill=VERDIGRIS, font=_font(26, "mono"))
    draw.text((card_x + 40, card_y + 420),
              "\u2192  civil modmail invite sent to user",
              fill=TEXT_SECONDARY, font=_font(26))
    draw.text((card_x + 40, card_y + 470),
              "    user CAN'T edit the mod's reason later.",
              fill=CORAL, font=_font(26, "italic"))

    _draw_caption(draw, 3, 7, "Action snapshot \u2014 the mod's original reason is preserved.")
    img.save(path, "PNG", optimize=True)


def frame_04_intake_form(path: Path):
    img, draw = _new()
    draw.text((MARGIN, 150), "Step 2 \u2014 Structured intake", fill=VERDIGRIS, font=_font(28, "bold"))
    draw.text((MARGIN, 200), "The user appeals through a form, not modmail.",
              fill=CREAM, font=_font(56, "bold"))

    # Mock form
    card_x, card_y, card_w, card_h = MARGIN, 360, 1500, 590
    draw.rectangle([card_x, card_y, card_x + card_w, card_y + card_h],
                   fill=PANEL, outline=VERDIGRIS, width=3)

    def row(y, label, value, locked=False, color=CREAM):
        draw.text((card_x + 40, y), label,
                  fill=TEXT_SECONDARY, font=_font(22))
        draw.text((card_x + 360, y - 4), value,
                  fill=color, font=_font(28, "mono"))
        if locked:
            draw.text((card_x + card_w - 200, y),
                      "\ud83d\udd12  read-only",
                      fill=CORAL, font=_font(20, "italic"))

    row(card_y + 50,  "Action type",  "ban_user",                          locked=True)
    row(card_y + 110, "Target",       "t2_a1b2c3d4",                       locked=True)
    row(card_y + 170, "Original",     "Breaking rule 3 \u2014 personal attacks", locked=True)
    row(card_y + 250, "Your reason",  "I was responding to harassment.",   color=CREAM)
    row(card_y + 290, "",             "I'd ask the mods to consider context.", color=CREAM)
    row(card_y + 380, "\u2713 acknowledged", "I understand this is final.",        color=VERDIGRIS)

    draw.rectangle([card_x + card_w - 320, card_y + card_h - 100,
                    card_x + card_w - 40, card_y + card_h - 40],
                   fill=VERDIGRIS)
    draw.text((card_x + card_w - 240, card_y + card_h - 92),
              "Submit appeal",
              fill=NAVY, font=_font(30, "bold"))

    _draw_caption(draw, 4, 7, "Structured intake \u2014 validated, sanitised, rate-limited, deduped.")
    img.save(path, "PNG", optimize=True)


def frame_05_dashboard(path: Path):
    img, draw = _new()
    draw.text((MARGIN, 150), "Step 3 \u2014 Mod dashboard", fill=VERDIGRIS, font=_font(28, "bold"))
    draw.text((MARGIN, 200), "Open queue. Full context. One tap.",
              fill=CREAM, font=_font(64, "bold"))

    # Mock queue
    card_x, card_y, card_w, card_h = MARGIN, 370, 1760, 590
    draw.rectangle([card_x, card_y, card_x + card_w, card_y + card_h],
                   fill=PANEL, outline=VERDIGRIS, width=3)
    draw.text((card_x + 40, card_y + 30),
              "Open appeals  \u00b7  r/appeal_desk_dev",
              fill=VERDIGRIS, font=_font(28, "bold"))

    rows = [
        ("u/example_user",   "ban_user",   "2h ago",  "history: 1",      "near-dup: 0.12", "low"),
        ("u/another_user",   "removelink", "5h ago",  "history: 3",      "near-dup: 0.84", "high"),
        ("u/third_user",     "ban_user",   "1d ago",  "history: 0",      "near-dup: 0.00", "low"),
    ]
    y = card_y + 100
    for user, action, when, hist, dup, severity in rows:
        draw.text((card_x + 40,  y), user,   fill=CREAM, font=_font(26, "mono"))
        draw.text((card_x + 380, y), action, fill=TEXT_PRIMARY, font=_font(24, "mono"))
        draw.text((card_x + 640, y), when,   fill=TEXT_SECONDARY, font=_font(24))
        draw.text((card_x + 820, y), hist,   fill=TEXT_SECONDARY, font=_font(24))
        dup_color = CORAL if severity == "high" else VERDIGRIS
        draw.text((card_x + 1080, y), dup,    fill=dup_color, font=_font(24, "mono"))
        y += 70

    # Three buttons
    bx = card_x + 40
    by = card_y + card_h - 110
    for label, color in [("Uphold", CORAL), ("Overturn", VERDIGRIS), ("Ask for more info", BLUE)]:
        bw = draw.textbbox((0, 0), label, font=_font(28, "bold"))[2] + 80
        draw.rectangle([bx, by, bx + bw, by + 70], fill=color)
        draw.text((bx + 40, by + 18), label, fill=NAVY, font=_font(28, "bold"))
        bx += bw + 30

    _draw_caption(draw, 5, 7, "Dashboard \u2014 history, near-duplicate flag, three one-tap buttons.")
    img.save(path, "PNG", optimize=True)


def frame_06_reply_confirm(path: Path):
    img, draw = _new()
    draw.text((MARGIN, 150), "Step 4 \u2014 Reply-confirm gate", fill=VERDIGRIS, font=_font(28, "bold"))
    draw.text((MARGIN, 200), "Nothing is sent until the mod confirms.",
              fill=CREAM, font=_font(56, "bold"))

    card_x, card_y, card_w, card_h = MARGIN, 360, 1600, 580
    draw.rectangle([card_x, card_y, card_x + card_w, card_y + card_h],
                   fill=PANEL, outline=VERDIGRIS, width=3)
    draw.text((card_x + 40, card_y + 30),
              "Decision  \u00b7  Overturn   (drafted, not yet sent)",
              fill=VERDIGRIS, font=_font(26, "bold"))

    draw.text((card_x + 40, card_y + 100),
              "Reply (editable, civil template):",
              fill=TEXT_SECONDARY, font=_font(22))
    reply_lines = [
        "Hi u/example_user, thanks for taking the time to write in.",
        "",
        "We've reviewed your appeal and the original context, and we agree this",
        "ban was the wrong call. The ban has been lifted with immediate effect.",
        "",
        "We're sorry for the friction. If you see anything similar happen again,",
        "please flag the modmail and we'll re-review.",
    ]
    y = card_y + 140
    for line in reply_lines:
        draw.text((card_x + 40, y), line, fill=CREAM, font=_font(24))
        y += 38

    draw.text((card_x + 40, card_y + card_h - 180),
              "[ AI hint: tone-softened from template-T2 \u2014 mod-editable ]",
              fill=TEXT_SECONDARY, font=_font(20, "italic"))

    # Two buttons: Cancel + Confirm send
    bx = card_x + card_w - 480
    by = card_y + card_h - 110
    draw.rectangle([bx, by, bx + 200, by + 70], outline=TEXT_SECONDARY, width=2)
    draw.text((bx + 60, by + 18), "Cancel", fill=TEXT_SECONDARY, font=_font(28, "bold"))
    draw.rectangle([bx + 230, by, bx + 230 + 230, by + 70], fill=VERDIGRIS)
    draw.text((bx + 270, by + 18), "Confirm \u2192 send", fill=NAVY, font=_font(26, "bold"))

    _draw_caption(draw, 6, 7, "AI drafts, the mod confirms. Decision recorded before reply is sent.")
    img.save(path, "PNG", optimize=True)


def frame_07_audit_outro(path: Path):
    img, draw = _new()
    draw.text((MARGIN, 150), "Step 5 \u2014 Audit trail + proof",
              fill=VERDIGRIS, font=_font(28, "bold"))
    draw.text((MARGIN, 200), "Every decision, reply, and state change \u2014 logged.",
              fill=CREAM, font=_font(50, "bold"))

    # KPI cells
    kpis = [
        ("288 / 288", "tests pass"),
        ("99.97 %",   "line coverage"),
        ("0",         "AI required"),
        ("4",         "BUILD commits"),
    ]
    cell_w, cell_h = 380, 220
    spacing = 30
    total_w = cell_w * 4 + spacing * 3
    start_x = (W - total_w) // 2
    y = 360
    for i, (big, small) in enumerate(kpis):
        x = start_x + i * (cell_w + spacing)
        draw.rectangle([x, y, x + cell_w, y + cell_h],
                       fill=PANEL, outline=VERDIGRIS, width=3)
        f_big = _font(78, "bold")
        bw = draw.textbbox((0, 0), big, font=f_big)[2]
        draw.text((x + (cell_w - bw) // 2, y + 30), big,
                  fill=CREAM, font=f_big)
        f_small = _font(26)
        sw = draw.textbbox((0, 0), small, font=f_small)[2]
        draw.text((x + (cell_w - sw) // 2, y + cell_h - 60), small,
                  fill=TEXT_SECONDARY, font=f_small)

    # Outro
    draw.text((MARGIN, 680),
              "AI assists. Humans decide. The audit trail proves it.",
              fill=CREAM, font=_font(44, "italic"))
    draw.text((MARGIN, 820), "developers.reddit.com/apps/appeal-desk",
              fill=VERDIGRIS, font=_font(34, "mono"))
    draw.text((MARGIN, 880), "github.com/vsenthil7/appeal-desk  \u00b7  MIT",
              fill=TEXT_SECONDARY, font=_font(26, "mono"))

    _draw_caption(draw, 7, 7, "Install today on r/appeal_desk_dev or your own test sub.")
    img.save(path, "PNG", optimize=True)


# ---------- Main ----------


def main():
    out_dir = Path(__file__).resolve().parent.parent / "submission_media" / "demovideo_frames"
    out_dir.mkdir(parents=True, exist_ok=True)

    frames = [
        ("01_title.png",           frame_01_title),
        ("02_problem.png",         frame_02_problem),
        ("03_action_snapshot.png", frame_03_action_snapshot),
        ("04_intake_form.png",     frame_04_intake_form),
        ("05_dashboard.png",       frame_05_dashboard),
        ("06_reply_confirm.png",   frame_06_reply_confirm),
        ("07_audit_outro.png",     frame_07_audit_outro),
    ]
    for name, fn in frames:
        out = out_dir / name
        fn(out)
        kb = out.stat().st_size // 1024
        print(f"  {name}: {kb} KB")
    print(f"frames -> {out_dir}")


if __name__ == "__main__":
    main()
