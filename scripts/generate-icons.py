#!/usr/bin/env python3
"""Generate the Polaris app icons (PNG set + macOS .icns) with the stdlib only.

Why a generator instead of hand-made files: this script is the single source of
truth for the mark, so any machine can rebuild the committed PNG/icns set and a
review can diff the script rather than a binary blob. The mark is a target ring
with a sparkle — "polaris" as a navigation star.

Usage:
    python3 scripts/generate-icons.py            # from the repo root
    python3 scripts/generate-icons.py --check    # verify icons exist, write nothing
"""
from __future__ import annotations

import argparse
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = REPO_ROOT / "app" / "src-tauri" / "icons"

# PNG sizes referenced by app/src-tauri/tauri.conf.json ("bundle.icon").
PNG_TARGETS: dict[str, int] = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}

# (file name, pixel size) required by `iconutil -c icns`.
ICNSET: list[tuple[str, int]] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

BACKGROUND_IN = (0x07, 0x0B, 0x18)  # deep space navy
BACKGROUND_OUT = (0x14, 0x1C, 0x3A)  # indigo
RING = (0xE2, 0xE8, 0xFF)  # near-white ring
SPARK = (0x7D, 0xD3, 0xFC)  # cyan sparkle


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 == edge0:
        return 0.0
    t = min(max((x - edge0) / (edge1 - edge0), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def _mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[float, float, float]:
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))  # type: ignore[return-value]


def render_rgba(size: int) -> bytes:
    """Render the mark at `size` x `size` pixels as raw RGBA rows (no filtering)."""
    center = (size - 1) / 2.0
    radius = size / 2.0
    out = bytearray()
    for y in range(size):
        for x in range(size):
            dx = (x - center) / radius
            dy = (y - center) / radius
            dist = math.hypot(dx, dy)

            rgb = _mix(BACKGROUND_IN, BACKGROUND_OUT, min(dist, 1.0))

            # Ring: soft annulus.
            ring = _smoothstep(0.56, 0.60, dist) * (1.0 - _smoothstep(0.72, 0.76, dist))
            if ring > 0:
                rgb = _mix(rgb, RING, ring)  # type: ignore[arg-type]

            # Sparkle: a four-point star (thin cross + diagonal accents).
            spike = max(
                1.0 - abs(dx) / (0.045 + 0.0) if abs(dy) < 0.34 else 0.0,
                1.0 - abs(dy) / 0.045 if abs(dx) < 0.34 else 0.0,
            )
            spike *= _smoothstep(0.06, 0.10, dist)
            if spike > 0:
                rgb = _mix(rgb, SPARK, min(spike, 1.0) * 0.95)  # type: ignore[arg-type]

            # Center dot.
            dot = 1.0 - _smoothstep(0.06, 0.11, dist)
            if dot > 0:
                rgb = _mix(rgb, SPARK, dot)  # type: ignore[arg-type]

            out += bytes((int(rgb[0]), int(rgb[1]), int(rgb[2]), 255))
    return bytes(out)


def _chunk(tag: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)


def write_png(path: Path, size: int) -> None:
    raw = render_rgba(size)
    stride = size * 4
    filtered = b"".join(b"\x00" + raw[y * stride : (y + 1) * stride] for y in range(size))
    blob = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(filtered, 9))
        + _chunk(b"IEND", b"")
    )
    path.write_bytes(blob)


def build_icns(dest: Path) -> bool:
    """Build `dest` with iconutil; returns False (with a warning) if unavailable."""
    if shutil.which("iconutil") is None:
        print("warn: iconutil not found (macOS only) — skipping .icns", file=sys.stderr)
        return False
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "polaris.iconset"
        iconset.mkdir()
        for name, size in ICNSET:
            write_png(iconset / name, size)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(dest)],
            check=True,
        )
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="only verify the icons exist")
    args = parser.parse_args()

    expected = [ICON_DIR / name for name in PNG_TARGETS] + [ICON_DIR / "icon.icns"]
    if args.check:
        missing = [str(p.relative_to(REPO_ROOT)) for p in expected if not p.exists()]
        if missing:
            print("missing icons:\n  " + "\n  ".join(missing), file=sys.stderr)
            print("run: python3 scripts/generate-icons.py", file=sys.stderr)
            return 1
        print(f"icons OK ({len(expected)} files)")
        return 0

    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for name, size in PNG_TARGETS.items():
        write_png(ICON_DIR / name, size)
        print(f"wrote {name} ({size}x{size})")
    if build_icns(ICON_DIR / "icon.icns"):
        print("wrote icon.icns")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())