"""生成扩展图标（无字体依赖：渐变圆角方块 + 白色播放三角）。"""
from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    pixels = img.load()
    # B站粉 #FB7299 -> B站蓝 #00AEEC
    for y in range(size):
        t = y / max(1, size - 1)
        r = round(251 + (0 - 251) * t)
        g = round(114 + (174 - 114) * t)
        b = round(153 + (236 - 153) * t)
        for x in range(size):
            pixels[x, y] = (r, g, b, 255)
    return img


for size in (16, 32, 48, 128):
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=max(2, size // 5), fill=255
    )
    canvas.paste(gradient(size), (0, 0), mask)
    draw = ImageDraw.Draw(canvas)
    draw.polygon(
        [
            (size * 0.40, size * 0.26),
            (size * 0.40, size * 0.74),
            (size * 0.76, size * 0.50),
        ],
        fill=(255, 255, 255, 255),
    )
    canvas.save(OUT / f"icon{size}.png")

print(f"icons written to {OUT}")
