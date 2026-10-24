#!/usr/bin/env python3
"""Construit les données hors ligne de Tegaki.

Entrées :
  --kanjivg   dossier `kanji/` de KanjiVG (https://github.com/KanjiVG/kanjivg)
  --jamdict   base SQLite jamdict.db (contient KANJIDIC2, avec sens fr/en/es/pt)
Sorties (dans --out) :
  kanji.json   fiches (sens, lectures, composants), triées par fréquence
  strokes.bin  tracés rééchantillonnés : pour chaque kanji, chaque trait, K points (x,y) en uint8
Option --dense : écrit aussi un échantillon de tracés denses pour les tests.

Licences : KanjiVG CC BY-SA 3.0 (Ulrich Apel) ; KANJIDIC2 CC BY-SA 4.0 (EDRDG).
"""
import argparse, json, math, os, random, re, sqlite3
from xml.etree import ElementTree as ET

K = 16            # points par trait
BOX = 255         # les tracés normalisés tiennent dans 0..255
MIN_SPAN = 0.12 * 109  # même garde-fou que recognizer.js (0.12 de la zone de dessin)

NUM = re.compile(r"[MmCcSsLlHhVvZz]|-?(?:\d+\.?\d*|\.\d+)")


def parse_path(d):
    """Parse un chemin SVG (M C S L H V, relatif ou absolu) -> polyligne dense."""
    toks = NUM.findall(d)
    i = 0
    pts = []
    x = y = 0.0
    cmd = None
    last_c2 = None
    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v
    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t; i += 1
            if cmd in "Zz":
                continue
        c = cmd
        if c in "Mm":
            nx, ny = num(), num()
            if c == "m": nx += x; ny += y
            x, y = nx, ny
            pts.append((x, y)); last_c2 = None
            cmd = "L" if c == "M" else "l"
        elif c in "Ll":
            nx, ny = num(), num()
            if c == "l": nx += x; ny += y
            x, y = nx, ny; pts.append((x, y)); last_c2 = None
        elif c in "Hh":
            nx = num(); x = nx + x if c == "h" else nx
            pts.append((x, y)); last_c2 = None
        elif c in "Vv":
            ny = num(); y = ny + y if c == "v" else ny
            pts.append((x, y)); last_c2 = None
        elif c in "Cc":
            v = [num() for _ in range(6)]
            if c == "c":
                v = [v[0]+x, v[1]+y, v[2]+x, v[3]+y, v[4]+x, v[5]+y]
            pts += cubic((x, y), (v[0], v[1]), (v[2], v[3]), (v[4], v[5]))
            last_c2 = (v[2], v[3]); x, y = v[4], v[5]
        elif c in "Ss":
            v = [num() for _ in range(4)]
            if c == "s":
                v = [v[0]+x, v[1]+y, v[2]+x, v[3]+y]
            c1 = (2*x - last_c2[0], 2*y - last_c2[1]) if last_c2 else (x, y)
            pts += cubic((x, y), c1, (v[0], v[1]), (v[2], v[3]))
            last_c2 = (v[0], v[1]); x, y = v[2], v[3]
        else:
            raise ValueError("commande non gérée: %s" % c)
    return pts


def cubic(p0, p1, p2, p3, n=20):
    out = []
    for k in range(1, n + 1):
        t = k / n; u = 1 - t
        out.append((u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
                    u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]))
    return out


def resample(pts, n=K):
    if len(pts) == 1:
        return [pts[0]] * n
    seg = [math.dist(pts[i], pts[i+1]) for i in range(len(pts)-1)]
    total = sum(seg)
    if total < 1e-9:
        return [pts[0]] * n
    out = []; j = 0; acc = 0.0
    for k in range(n):
        target = total * k / (n - 1)
        while j < len(seg) - 1 and acc + seg[j] < target:
            acc += seg[j]; j += 1
        f = 0 if seg[j] == 0 else min(1.0, max(0.0, (target - acc) / seg[j]))
        out.append((pts[j][0] + (pts[j+1][0]-pts[j][0])*f, pts[j][1] + (pts[j+1][1]-pts[j][1])*f))
    return out


def normalize(strokes):
    """Boîte englobante -> 0..255, ratio conservé, centré (identique côté JS)."""
    xs = [p[0] for s in strokes for p in s]; ys = [p[1] for s in strokes for p in s]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    span = max(maxx - minx, maxy - miny, MIN_SPAN)
    sc = BOX / span
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    return [[((p[0]-cx)*sc + BOX/2, (p[1]-cy)*sc + BOX/2) for p in s] for s in strokes]


def walk(g, ns_el, is_known, out):
    """Composants : on s'arrête aux éléments qui ont un sens connu, sinon on descend."""
    for ch in g:
        if not ch.tag.endswith("}g") and ch.tag != "g":
            continue
        attrs = {k.split("}")[-1]: v for k, v in ch.attrib.items()}
        el = attrs.get("element")
        if "part" in attrs:       # fragment d'un élément éclaté, on ignore
            continue
        base = attrs.get("original") or el
        if el and base and is_known(base):
            pair = [el, base] if el != base else [el]
            if pair not in out:
                out.append(pair)
        else:
            walk(ch, ns_el, is_known, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kanjivg", required=True)
    ap.add_argument("--jamdict", required=True)
    ap.add_argument("--out", default="data")
    ap.add_argument("--dense", help="écrit un échantillon de tracés denses (JSON) pour les tests")
    ap.add_argument("--dense-n", type=int, default=800)
    ap.add_argument("--dense-extra", default="語水日明休学校", help="kanji à inclure d'office dans l'échantillon")
    a = ap.parse_args()

    db = sqlite3.connect(a.jamdict)
    chars = {}
    for cid, lit, sc, grade, freq, jlpt in db.execute("select ID,literal,stroke_count,grade,freq,jlpt from character"):
        chars[lit] = dict(id=cid, s=int(sc or 0), g=int(grade or 0), f=int(freq or 0), j=int(jlpt or 0))
    for lit, c in chars.items():
        gids = [r[0] for r in db.execute("select ID from rm_group where cid=?", (c["id"],))]
        fr, en, on, kun = [], [], [], []
        for gid in gids:
            for v, lang in db.execute("select value,m_lang from meaning where gid=?", (gid,)):
                (fr if lang == "fr" else en if lang in ("", "en") else []).append(v)
            for t, v in db.execute("select r_type,value from reading where gid=?", (gid,)):
                if t == "ja_on": on.append(v)
                elif t == "ja_kun": kun.append(v)
        c.update(fr=fr, en=en, on=on, kun=kun)

    known = {l for l, c in chars.items() if c["fr"] or c["en"]}

    # lecture de KanjiVG (fichiers de base uniquement, pas les variantes -Kaisho etc.)
    items = []
    for fn in sorted(os.listdir(a.kanjivg)):
        m = re.fullmatch(r"([0-9a-f]{5})\.svg", fn)
        if not m:
            continue
        lit = chr(int(m.group(1), 16))
        if lit not in chars or not (chars[lit]["fr"] or chars[lit]["en"]):
            continue
        if not (0x4E00 <= ord(lit) <= 0x9FFF or 0x3400 <= ord(lit) <= 0x4DBF or lit in "々〆"):
            continue
        root = ET.parse(os.path.join(a.kanjivg, fn)).getroot()
        paths = [p for p in root.iter() if p.tag.endswith("}path") or p.tag == "path"]
        dense = [parse_path(p.attrib["d"]) for p in paths]
        if not dense:
            continue
        top = next(g for g in root.iter() if g.attrib.get("id", "") == "kvg:" + m.group(1))
        comps = []
        walk(top, None, lambda b, lit=lit: b != lit and b in known, comps)
        items.append((lit, dense, comps))

    items.sort(key=lambda it: (chars[it[0]]["f"] or 99999, ord(it[0])))
    kanji, blob = [], bytearray()
    dense_dump = {}
    for lit, dense, comps in items:
        c = chars[lit]
        res = normalize([resample(d) for d in dense])
        for s in res:
            for x, y in s:
                blob += bytes([min(255, max(0, round(x))), min(255, max(0, round(y)))])
        rec = {"c": lit, "s": len(dense)}
        if c["g"]: rec["g"] = c["g"]
        if c["j"]: rec["j"] = c["j"]
        if c["f"]: rec["f"] = c["f"]
        if c["fr"]: rec["fr"] = c["fr"]
        if c["en"]: rec["en"] = c["en"]
        if c["on"]: rec["on"] = c["on"]
        if c["kun"]: rec["kun"] = c["kun"]
        if comps: rec["p"] = comps
        kanji.append(rec)
        dense_dump[lit] = dense

    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "kanji.json"), "w", encoding="utf-8") as f:
        json.dump({"k": K, "kanji": kanji}, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(a.out, "strokes.bin"), "wb") as f:
        f.write(blob)
    n_fr = sum(1 for k in kanji if "fr" in k)
    print(f"{len(kanji)} kanji, {sum(k['s'] for k in kanji)} traits, {len(blob)/1e6:.2f} Mo de tracés, {n_fr} avec sens français")

    if a.dense:
        rnd = random.Random(42)
        pick = rnd.sample(sorted(dense_dump), min(a.dense_n, len(dense_dump)))
        pick += [c for c in a.dense_extra if c in dense_dump and c not in pick]
        with open(a.dense, "w", encoding="utf-8") as f:
            json.dump({c: [[[round(x, 2), round(y, 2)] for x, y in s] for s in dense_dump[c]] for c in pick}, f, ensure_ascii=False, separators=(",", ":"))
        print("échantillon dense:", len(pick))


if __name__ == "__main__":
    main()
