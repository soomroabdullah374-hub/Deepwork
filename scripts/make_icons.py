"""Render DeepWork's app icons, splash and notification icon from the logo spec.

Logo (viewBox 0 0 100 100): ring centre (50, 50), r 38, stroke 15, round caps, 80 % arc
starting at 12 o'clock and running clockwise; dot at (27.7, 19.3), r 7.5.
Run: python3 scripts/make_icons.py   (needs Pillow)
"""
from pathlib import Path
import math

from PIL import Image, ImageDraw

KILN = (184, 83, 47, 255)       # #B8532F, button / icon background
IVORY = (250, 249, 245, 255)    # #FAF9F5
MARK = (201, 100, 66, 255)      # #C96442
OUT = Path(__file__).resolve().parent.parent / 'app' / 'assets'
SS = 4  # supersampling for smooth edges


def mark(size: int, scale: float, color, bg=(0, 0, 0, 0)) -> Image.Image:
    """The mark drawn into a square canvas; `scale` = mark width as a share of the canvas."""
    big = size * SS
    img = Image.new('RGBA', (big, big), bg)
    d = ImageDraw.Draw(img)
    unit = big * scale / 100            # one viewBox unit in pixels
    ox = oy = (big - 100 * unit) / 2     # centre the 100 x 100 viewBox
    cx, cy, r, w = 50, 50, 38, 15
    # Pillow strokes an arc inward from its box, so the box is the ring's outer edge
    ro = r + w / 2
    box = [ox + (cx - ro) * unit, oy + (cy - ro) * unit, ox + (cx + ro) * unit, oy + (cy + ro) * unit]
    start, end = -90, -90 + 288          # PIL: 0 deg = 3 o'clock, clockwise
    d.arc(box, start, end, fill=color, width=round(w * unit))
    for a in (start, end):               # round caps
        x = ox + (cx + r * math.cos(math.radians(a))) * unit
        y = oy + (cy + r * math.sin(math.radians(a))) * unit
        rr = w / 2 * unit
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=color)
    dx, dy, dr = 27.7, 19.3, 7.5
    d.ellipse([ox + (dx - dr) * unit, oy + (dy - dr) * unit, ox + (dx + dr) * unit, oy + (dy + dr) * unit], fill=color)
    return img.resize((size, size), Image.LANCZOS)


def save(img: Image.Image, name: str, opaque=False):
    if opaque:
        img = img.convert('RGB')
    img.save(OUT / name)
    print('wrote', OUT / name, img.size)


# iOS / store icon: ivory mark on Kiln, no transparency
save(mark(1024, 0.56, IVORY, KILN), 'icon.png', opaque=True)
# Android adaptive icon: foreground mark on transparent (safe zone is the middle 66 %),
# Kiln background, and a monochrome version for themed icons
save(mark(1024, 0.44, IVORY), 'android-icon-foreground.png')
save(Image.new('RGBA', (1024, 1024), KILN), 'android-icon-background.png')
save(mark(1024, 0.44, (255, 255, 255, 255)), 'android-icon-monochrome.png')
# Native splash: plain Kiln with the ivory mark (the animated launch screen follows)
save(mark(512, 0.86, IVORY), 'splash-icon.png')
# Status-bar notification icon: white silhouette on transparent
save(mark(96, 0.86, (255, 255, 255, 255)), 'notification-icon.png')
save(mark(48, 0.9, MARK), 'favicon.png')
