"""Render the Lazy - Cut app icon → assets/icon.png (1024 px) and assets/icon.icns.

Motif: a pair of scissors taking a nap ("z z") next to a dashed cut line —
"lazy" + "cut", in white on a dnoms blue gradient macOS squircle.
Every icon size is drawn from vector shapes (supersampled, then downscaled), and the
smallest sizes drop the fine details (dashes, small "z") so the icon stays legible.

Usage (needs Pillow + numpy, e.g. the dev venv):
    python tools/make_icon.py            # writes assets/icon.png and assets/icon.icns
    python tools/make_icon.py --preview  # also writes a size sheet next to the icon
"""
from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")

# Brand palette (SPEC §5.3)
BLUE = (0x24, 0x50, 0xF5)
BLUE_2 = (0x6F, 0x9B, 0xFF)
INK_SHADOW = (8, 22, 90)

# Design grid: 1024-unit canvas, Apple's macOS icon body = 824 units centered (100 margin).
BODY = 824
MARGIN = (1024 - BODY) / 2

# iconutil set: name → pixel size
ICONSET = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]


class Pen:
    """Draws white shapes into an 'L' mask using 1024-unit design coordinates.

    `zoom` scales the motif around the icon center (used to enlarge it at tiny sizes).
    """

    def __init__(self, size_px: int, k: float, zoom: float = 1.0):
        self.k = k
        self.zoom = zoom
        self.mask = Image.new("L", (size_px, size_px), 0)
        self.d = ImageDraw.Draw(self.mask)

    def _p(self, pt):
        z = self.zoom
        return ((512 + (pt[0] - 512) * z) * self.k, (512 + (pt[1] - 512) * z) * self.k)

    def _len(self, v):
        return v * self.zoom * self.k

    def dot(self, c, r, fill=255):
        x, y = self._p(c)
        r = self._len(r)
        self.d.ellipse((x - r, y - r, x + r, y + r), fill=fill)

    def capsule(self, a, b, w, fill=255):
        """Thick line with round caps."""
        self.d.line([self._p(a), self._p(b)], fill=fill, width=max(1, round(self._len(w))))
        self.dot(a, w / 2, fill)
        self.dot(b, w / 2, fill)

    def polyline(self, pts, w, fill=255):
        for a, b in zip(pts, pts[1:]):
            self.capsule(a, b, w, fill)

    def polygon(self, pts, fill=255):
        self.d.polygon([self._p(p) for p in pts], fill=fill)

    def ring(self, c, r_out, r_in):
        self.dot(c, r_out, 255)
        self.dot(c, r_in, 0)


def _add(a, b, s=1.0):
    return (a[0] + b[0] * s, a[1] + b[1] * s)


def draw_motif(pen: Pen, detail: str) -> None:
    """detail: 'full' (>=128 px), 'medium' (64 px), 'small' (<=32 px: bolder, one "z", no dashes)."""
    small = detail == "small"
    bold = {"full": 1.0, "medium": 1.15, "small": 1.35}[detail]

    # --- scissors lying on their side, slightly open, blades pointing right ------------
    pivot = (430.0, 632.0)
    blade_len = 232.0
    half_angle = math.radians(11.0)
    w0 = 42.0 * bold                      # blade width at the pivot
    ring_r, ring_w = 62.0, 30.0 * bold    # finger rings (center-line radius, stroke)
    ring_dx, ring_dy = 196.0, 88.0        # ring centers relative to the pivot

    for sign in (+1, -1):                 # +1: blade to the lower right (upper ring), -1: mirrored
        u = (math.cos(half_angle), sign * math.sin(half_angle))
        out = (-u[1] * sign, u[0] * sign)  # normal pointing away from the opening
        tip = _add(pivot, u, blade_len)
        # straight cutting edge on the inside, curved back on the outside → sharp tip
        back = []
        for i in range(0, 11):
            t = i / 10.0
            back.append(_add(_add(pivot, u, t * blade_len), out, w0 * (1 - t) ** 0.6))
        pen.polygon([_add(pivot, out, -w0 * 0.25)] + back + [tip])
        # shank + finger ring on the opposite side of the pivot
        ring_c = (pivot[0] - ring_dx, pivot[1] - sign * ring_dy)
        d = (ring_c[0] - pivot[0], ring_c[1] - pivot[1])
        dl = math.hypot(*d)
        shank_end = _add(pivot, (d[0] / dl, d[1] / dl), dl - ring_r)
        pen.capsule(pivot, shank_end, 36.0 * bold)
        pen.ring(ring_c, ring_r + ring_w / 2, ring_r - ring_w / 2)
    pen.dot(pivot, w0 * 0.95)             # solid hub where the blades cross
    if not small:
        pen.dot(pivot, 13.0 * bold, 0)    # screw: background shows through
        pen.dot(pivot, 5.0 * bold, 255)

    # --- dashed cut line continuing from the blade tips ---------------------------------
    if not small:
        w = 20.0 * bold
        seen_dash, seen_gap = 46.0, 21.0          # visible lengths (round caps included)
        x = pivot[0] + blade_len + 18
        while x + seen_dash <= 862:
            pen.capsule((x + w / 2, pivot[1]), (x + seen_dash - w / 2, pivot[1]), w)
            x += seen_dash + seen_gap

    # --- "z z": the scissors are napping ------------------------------------------------
    def zee(cx, cy, s, w):
        h = s * 0.5
        pen.polyline([(cx - h, cy - h), (cx + h, cy - h), (cx - h, cy + h), (cx + h, cy + h)], w)

    if small:
        zee(690, 352, 170, 44)
    else:
        zee(598, 426, 78, 25 * bold)
        zee(728, 298, 128, 33 * bold)


def squircle_mask(size_px: int, k: float) -> Image.Image:
    """Rounded body (824 units, corner radius 22.4% like Apple's macOS template)."""
    m = Image.new("L", (size_px, size_px), 0)
    a, b = MARGIN * k, (1024 - MARGIN) * k
    ImageDraw.Draw(m).rounded_rectangle((a, a, b, b), radius=BODY * 0.224 * k, fill=255)
    return m


def gradient(size_px: int) -> Image.Image:
    """Diagonal brand gradient: light blue (top-left) → brand blue (bottom-right)."""
    yy, xx = np.mgrid[0:size_px, 0:size_px].astype(np.float32) / max(1, size_px - 1)
    t = np.clip((0.35 * xx + 0.65 * yy - 0.08) / 0.84, 0, 1)[..., None]
    t = t ** 0.9
    c0 = np.array(BLUE_2, np.float32)
    c1 = np.array(BLUE, np.float32)
    rgb = c0 * (1 - t) + c1 * t
    return Image.fromarray(rgb.astype(np.uint8)).convert("RGBA")


def render(px: int) -> Image.Image:
    ss = 4 if px <= 512 else 2                       # supersampling factor
    size = px * ss
    k = size / 1024.0
    detail = "full" if px >= 128 else ("medium" if px >= 64 else "small")

    body = squircle_mask(size, k)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # drop shadow under the body (Apple-style, inside the 100-unit margin)
    if px >= 64:
        sh = Image.new("RGBA", (size, size), INK_SHADOW + (0,))
        sh_mask = ImageChops.offset(body, 0, round(10 * k)).filter(ImageFilter.GaussianBlur(14 * k))
        sh.putalpha(sh_mask.point(lambda v: int(v * 0.32)))
        canvas = Image.alpha_composite(canvas, sh)

    grad = gradient(size)
    # soft highlight at the top of the body
    hl = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    ramp = np.clip(1 - (np.arange(size, dtype=np.float32) / size - 0.10) / 0.45, 0, 1) * 0.10
    hl.putalpha(Image.fromarray((np.repeat(ramp[:, None], size, 1) * 255).astype(np.uint8)))
    grad = Image.alpha_composite(grad, hl)
    grad.putalpha(body)
    canvas = Image.alpha_composite(canvas, grad)

    # white motif with a soft navy shadow for depth
    pen = Pen(size, k, zoom=1.12 if detail == "small" else 1.0)
    draw_motif(pen, detail)
    motif = ImageChops.multiply(pen.mask, body)
    if px >= 64:
        msh = Image.new("RGBA", (size, size), INK_SHADOW + (0,))
        m = ImageChops.offset(motif, 0, round(8 * k)).filter(ImageFilter.GaussianBlur(10 * k))
        msh.putalpha(ImageChops.multiply(m.point(lambda v: int(v * 0.30)), body))
        canvas = Image.alpha_composite(canvas, msh)
    white = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    white.putalpha(motif)
    canvas = Image.alpha_composite(canvas, white)

    return canvas.resize((px, px), Image.LANCZOS)


def build_icns(out_icns: str) -> None:
    if not shutil.which("iconutil"):
        raise SystemExit("iconutil not found (macOS only)")
    tmp = tempfile.mkdtemp(prefix="lazycut-icon-")
    try:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        cache = {}
        for name, px in ICONSET:
            if px not in cache:
                cache[px] = render(px)
            cache[px].save(os.path.join(iconset, name))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out_icns], check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def preview_sheet(path: str) -> None:
    sizes = [16, 32, 64, 128, 256, 512]
    pad = 24
    w = sum(sizes) + pad * (len(sizes) + 1)
    h = max(sizes) + 2 * pad
    sheet = Image.new("RGBA", (w * 2, h), (255, 255, 255, 255))
    dark = Image.new("RGBA", (w, h), (30, 30, 34, 255))
    sheet.paste(dark, (w, 0))
    for off in (0, w):
        x = off + pad
        for s in sizes:
            im = render(s)
            sheet.alpha_composite(im, (x, (h - s) // 2))
            x += s + pad
    sheet.save(path)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=ASSETS, help="output folder (default: assets/)")
    ap.add_argument("--preview", action="store_true", help="also write icon_preview.png (sizes on light/dark)")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    png = os.path.join(args.out, "icon.png")
    render(1024).save(png, optimize=True)
    build_icns(os.path.join(args.out, "icon.icns"))
    print(png)
    print(os.path.join(args.out, "icon.icns"))
    if args.preview:
        p = os.path.join(args.out, "icon_preview.png")
        preview_sheet(p)
        print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
