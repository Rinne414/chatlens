"""Builds WebP test fixtures with Pillow (libwebp) and the decoded pixels as
the expected answer. Usage: python make_webp_fixtures.py <out_dir>"""

import gzip
import io
import json
import random
import struct
import sys
from pathlib import Path

from PIL import Image

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
random.seed(20261001)


def save(name, image, **params):
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", **params)
    data = buffer.getvalue()
    (out / f"{name}.webp").write_bytes(data)
    decoded = Image.open(io.BytesIO(data)).convert("RGBA")
    (out / f"{name}.rgba").write_bytes(decoded.tobytes())
    chunks = []
    pos = 12
    while pos + 8 <= len(data):
        kind = data[pos : pos + 4].decode("latin1")
        size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        extra = f" hdr=0x{data[pos + 8]:02x}" if kind == "ALPH" else ""
        chunks.append(f"{kind}({size}{extra})")
        pos += 8 + size + (size % 2)
    print(f"{name}: {image.size} {len(data)} bytes {' '.join(chunks)}")


def busy_rgba(width, height):
    image = Image.new("RGBA", (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            if (x // 7 + y // 5) % 4 == 0:
                pixels[x, y] = (200, 40, 90, 255)  # flat patches: backward references
            elif x > width * 2 // 3:
                pixels[x, y] = (
                    x * 4 % 256,
                    y * 5 % 256,
                    (x + y) * 3 % 256,
                    (x * y) % 256,
                )
            else:
                pixels[x, y] = (
                    (x * 3 + random.randint(0, 6)) % 256,
                    (y * 7 + random.randint(0, 6)) % 256,
                    (x * y + random.randint(0, 6)) % 256,
                    255 if y < height - 6 else random.randint(0, 255),
                )
    return image


save(
    "lossless-rgba", busy_rgba(61, 47), lossless=True, quality=100, method=6, exact=True
)
save(
    "lossless-rgba-fast",
    busy_rgba(33, 90),
    lossless=True,
    quality=10,
    method=0,
    exact=True,
)

for colors in (2, 4, 12, 200):
    palette = [
        (
            random.randint(0, 255),
            random.randint(0, 255),
            random.randint(0, 255),
            random.choice((255, 255, 128, 0)),
        )
        for _ in range(colors)
    ]
    image = Image.new("RGBA", (53, 31))
    pixels = image.load()
    for y in range(31):
        for x in range(53):
            pixels[x, y] = palette[(x // 3 + y // 2 + random.randint(0, 1)) % colors]
    save(
        f"lossless-palette-{colors}",
        image,
        lossless=True,
        quality=100,
        method=6,
        exact=True,
    )

# Lossy colour + lossless alpha carrying a stealth payload: QQ's 720 previews.
metadata = json.dumps(
    {
        "Software": "NovelAI",
        "Description": "1girl, solo, rain",
        "Comment": json.dumps(
            {
                "prompt": "1girl, solo, rain",
                "uc": "lowres",
                "steps": 28,
                "scale": 5,
                "seed": 42,
            }
        ),
    }
).encode()
payload = gzip.compress(metadata)
bits = []
for byte in b"stealth_pngcomp" + struct.pack(">I", len(payload) * 8) + payload:
    bits.extend((byte >> shift) & 1 for shift in range(7, -1, -1))
width, height = 72, 150
image = Image.new("RGBA", (width, height))
pixels = image.load()
for y in range(height):
    for x in range(width):
        pixels[x, y] = ((x * 5) % 256, (y * 3) % 256, (x * y) % 256, 254)
for index, bit in enumerate(bits):
    x, y = divmod(index, height)
    r, g, b, a = pixels[x, y]
    pixels[x, y] = (r, g, b, (a & 0xFE) | bit)
save("lossy-alpha-stealth", image, quality=80, alpha_quality=100, method=6)

# Smooth alpha so the encoder picks an alpha filter.
for name, shape in (
    ("lossy-alpha-gradient-h", lambda x, y: x * 3),
    ("lossy-alpha-gradient-v", lambda x, y: y * 3),
    ("lossy-alpha-gradient-d", lambda x, y: x * 2 + y),
):
    image = Image.new("RGBA", (80, 60))
    pixels = image.load()
    for y in range(60):
        for x in range(80):
            pixels[x, y] = (x * 3 % 256, y * 4 % 256, 128, min(255, shape(x, y)))
    save(name, image, quality=70, alpha_quality=100, method=6)
