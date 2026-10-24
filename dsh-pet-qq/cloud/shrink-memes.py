#!/usr/bin/env python3
"""把 data/memes 下的表情包缩到「正常聊天尺寸」。

QQ 里图片按像素显示，384px 的图会占满半个屏幕；缩到最长边 <= 200px 就接近
微信/QQ 里普通表情的观感，同时体积能降一个数量级（发得也快）。

用法：
    python shrink-memes.py            # 原地缩放 data/memes
    python shrink-memes.py --dry      # 只看会改哪些
"""
import os
import sys

from PIL import Image, ImageSequence

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'memes')
MAX_SIDE = 240
EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}


def target_size(w, h):
    if max(w, h) <= MAX_SIDE:
        return w, h
    scale = MAX_SIDE / float(max(w, h))
    return max(1, round(w * scale)), max(1, round(h * scale))


def shrink(path, dry=False):
    ext = os.path.splitext(path)[1].lower()
    before = os.path.getsize(path)
    try:
        with Image.open(path) as im:
            w, h = im.size
            tw, th = target_size(w, h)
            if (tw, th) == (w, h):
                return before, before, False
            if dry:
                return before, before, True
            if ext == '.gif':
                frames = []
                durations = []
                for frame in ImageSequence.Iterator(im):
                    durations.append(frame.info.get('duration', 80))
                    frames.append(frame.convert('RGBA').resize((tw, th), Image.LANCZOS))
                frames[0].save(path, save_all=True, append_images=frames[1:],
                               duration=durations, loop=im.info.get('loop', 0), optimize=True)
            elif ext in ('.jpg', '.jpeg'):
                im.convert('RGB').resize((tw, th), Image.LANCZOS).save(path, 'JPEG', quality=88, optimize=True)
            else:
                im.convert('RGBA').resize((tw, th), Image.LANCZOS).save(path, 'PNG', optimize=True)
        return before, os.path.getsize(path), True
    except Exception as e:  # noqa: BLE001
        print(f'  跳过 {os.path.basename(path)}：{e}')
        return before, before, False


def main():
    dry = '--dry' in sys.argv
    total_before = total_after = 0
    changed = skipped = 0
    for base, _, files in os.walk(ROOT):
        for name in sorted(files):
            if os.path.splitext(name)[1].lower() not in EXTS:
                continue
            path = os.path.join(base, name)
            b, a, did = shrink(path, dry)
            total_before += b
            total_after += a
            if did:
                changed += 1
            else:
                skipped += 1
    print(f'缩放 {changed} 张，跳过 {skipped} 张'
          f'（{total_before / 1048576:.1f} MB → {total_after / 1048576:.1f} MB，最长边 <= {MAX_SIDE}px）')


if __name__ == '__main__':
    main()

