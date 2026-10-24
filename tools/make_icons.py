#!/usr/bin/env python3
"""Icônes de l'appli : le kanji 字 dessiné avec les tracés KanjiVG (CC BY-SA 3.0, Ulrich Apel)."""
import sys, os
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(__file__))
from build_data import parse_path
from xml.etree import ElementTree as ET

svg, out = sys.argv[1], sys.argv[2]
root = ET.parse(svg).getroot()
strokes = [parse_path(p.attrib['d']) for p in root.iter() if p.tag.endswith('path')]
BG, FG = (47, 74, 158), (244, 246, 252)

def render(size, margin):
    S = size * 4
    im = Image.new('RGB', (S, S), BG)
    d = ImageDraw.Draw(im)
    inner = S * (1 - 2 * margin)
    sc = inner / 109
    ox = oy = S * margin
    w = max(2, int(3.6 * sc))
    for st in strokes:
        pts = [(ox + x * sc, oy + y * sc) for x, y in st]
        d.line(pts, fill=FG, width=w, joint='curve')
        for x, y in (pts[0], pts[-1]):
            d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=FG)
    return im.resize((size, size), Image.LANCZOS)

os.makedirs(out, exist_ok=True)
render(192, 0.12).save(f'{out}/icon-192.png')
render(512, 0.12).save(f'{out}/icon-512.png')
render(512, 0.26).save(f'{out}/icon-maskable-512.png')   # zone sûre des icônes adaptatives
render(180, 0.12).save(f'{out}/apple-touch-icon.png')
print('icônes écrites dans', out)
