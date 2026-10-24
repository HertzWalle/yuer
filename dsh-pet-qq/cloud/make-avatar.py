"""生成 dsh大肥鱼 主题头像：蓝毛小女仆（大肥鱼）胸像 + 蓝色渐变圆底。

源图取自 dsh-pet 自带表情包 assets/memes/压力一只大肥鱼.png（384x384），
裁掉顶部文字，只保留人物胸像，缩放后贴到渐变圆底上。
输出：cloud/avatar.png（640x640 PNG）
"""

from PIL import Image, ImageDraw, ImageFilter
import os

SRC = r"C:\Users\黄志\.dsh\profiles\desktop\node_modules\dsh-pet\assets\memes\压力一只大肥鱼.png"
OUT = r"E:\DeepSeekWorkSpace\dsh-pet-qq\cloud\avatar.png"
SIZE = 640
# 源图里人物的胸像区域（避开顶部文字与两侧问号）
CROP = (88, 120, 334, 384)

src = Image.open(SRC).convert("RGBA")
face = src.crop(CROP)

# ---- 背景：竖向渐变 + 几颗气泡 ----
bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
grad = Image.new("RGBA", (SIZE, SIZE))
gd = ImageDraw.Draw(grad)
top = (206, 228, 255)
bottom = (126, 168, 230)
for y in range(SIZE):
    t = y / (SIZE - 1)
    color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    gd.line([(0, y), (SIZE, y)], fill=color)
bg = grad

bubbles = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bd = ImageDraw.Draw(bubbles)
for cx, cy, r, a in [(96, 110, 26, 60), (556, 92, 18, 70), (588, 300, 34, 45),
                     (72, 470, 22, 50), (300, 66, 12, 60), (520, 540, 16, 40)]:
    bd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, a))
bubbles = bubbles.filter(ImageFilter.GaussianBlur(1.2))
bg.alpha_composite(bubbles)

# ---- 人物：等比缩放到高约 88% ----
target_h = int(SIZE * 0.98)
ratio = target_h / face.height
target_w = int(face.width * ratio)
face = face.resize((target_w, target_h), Image.LANCZOS)


x0 = (SIZE - target_w) // 2
y0 = SIZE - target_h + 10          # 略往下沉，裁掉一点底部
layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
layer.alpha_composite(face, (x0, y0))
bg.alpha_composite(layer)

# ---- 圆形裁剪 + 白色细环 ----
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).ellipse([0, 0, SIZE - 1, SIZE - 1], fill=255)
out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
out.paste(bg, (0, 0), mask)

ring = ImageDraw.Draw(out)
ring.ellipse([6, 6, SIZE - 7, SIZE - 7], outline=(255, 255, 255, 235), width=9)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
out.save(OUT)
print(f"已生成 {OUT}  {out.size[0]}x{out.size[1]}  {os.path.getsize(OUT) // 1024} KB")

