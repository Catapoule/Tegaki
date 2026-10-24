// Évalue la reconnaissance sur des tracés synthétiques "écrits à la main" (bruités).
// usage : node tests/eval.mjs <dense.json> [niveau: doux|moyen|fort] [n]
import fs from 'node:fs';
import { Recognizer } from '../js/recognizer.js';

const [,, densePath, level = 'moyen', nArg = '400', scenario = 'aucun'] = process.argv;
const dense = JSON.parse(fs.readFileSync(densePath, 'utf8'));
const data = JSON.parse(fs.readFileSync(new URL('../data/kanji.json', import.meta.url), 'utf8'));
const buf = fs.readFileSync(new URL('../data/strokes.bin', import.meta.url));
const rec = new Recognizer(data.kanji, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const index = new Map(data.kanji.map((k, i) => [k.c, i]));

// générateur pseudo-aléatoire reproductible
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const U = (a, b) => a + (b - a) * rnd();

const L = { doux: 0.5, moyen: 1, fort: 1.7 }[level];

// Erreurs typiques d'un vrai scripteur
function mess(strokes) {
  const st = strokes.map((s) => s.slice());
  const n = st.length;
  if (scenario === 'ordre' && n > 2) { const i = Math.floor(rnd() * (n - 1)); [st[i], st[i + 1]] = [st[i + 1], st[i]]; }
  if (scenario === 'manque' && n > 2) st.splice(Math.floor(rnd() * n), 1);
  if (scenario === 'fusion' && n > 2) { const i = Math.floor(rnd() * (n - 1)); st.splice(i, 2, st[i].concat(st[i + 1])); }
  if (scenario === 'coupe' && n > 1) { const i = Math.floor(rnd() * n); const s = st[i]; const m = Math.floor(s.length / 2); if (m > 1) st.splice(i, 1, s.slice(0, m + 1), s.slice(m)); }
  return st;
}

function handwrite(strokes) {
  strokes = mess(strokes);
  const sx = 1 + U(-0.12, 0.12) * L, sy = 1 + U(-0.12, 0.12) * L;
  const rot = U(-4, 4) * L * Math.PI / 180, shear = U(-0.06, 0.06) * L;
  const tx = U(-0.04, 0.04), ty = U(-0.04, 0.04);
  const out = [];
  for (const st of strokes) {
    // coupe aléatoire des extrémités (on démarre/arrête rarement pile)
    const n = st.length;
    const a = Math.floor(n * U(0, 0.04) * L), b = n - Math.floor(n * U(0, 0.04) * L);
    let pts = st.slice(a, Math.max(a + 2, b)).map(([x, y]) => [x / 109 - 0.5, y / 109 - 0.5]);
    // ondulation basse fréquence + bruit
    const ph = U(0, 6.28), amp = 0.012 * L, f = U(1, 2.5);
    const dxs = U(-0.012, 0.012) * L, dys = U(-0.012, 0.012) * L;
    pts = pts.map(([x, y], k) => {
      const t = k / Math.max(1, pts.length - 1);
      const w = Math.sin(ph + t * f * 6.28) * amp;
      let X = x + w + dxs + gauss() * 0.003 * L, Y = y - w + dys + gauss() * 0.003 * L;
      X *= sx; Y *= sy;
      const Xr = X * Math.cos(rot) - Y * Math.sin(rot) + shear * Y;
      const Yr = X * Math.sin(rot) + Y * Math.cos(rot);
      return [Xr + 0.5 + tx, Yr + 0.5 + ty];
    });
    out.push(pts);
  }
  return out;
}

const chars = Object.keys(dense).filter((c) => index.has(c)).slice(0, Number(nArg));
let top1 = 0, top5 = 0, top10 = 0, top24 = 0, ms = 0;
const misses = [];
for (const c of chars) {
  const strokes = handwrite(dense[c]);
  const t0 = performance.now();
  const res = rec.recognize(strokes, 24);
  ms += performance.now() - t0;
  const pos = res.findIndex((r) => r.i === index.get(c));
  if (pos === 0) top1++;
  if (pos >= 0 && pos < 5) top5++;
  if (pos >= 0 && pos < 10) top10++;
  if (pos >= 0) top24++;
  if (pos !== 0) misses.push(`${c}→${res.slice(0, 3).map((r) => data.kanji[r.i].c).join('')}`);
}
const n = chars.length, pct = (v) => (100 * v / n).toFixed(1) + '%';
console.log(`scénario=${scenario} niveau=${level} n=${n}  top1=${pct(top1)} top5=${pct(top5)} top10=${pct(top10)} top24=${pct(top24)}  ${(ms / n).toFixed(0)} ms/requête`);
if (process.env.MISSES) console.log(misses.slice(0, 40).join('  '));
