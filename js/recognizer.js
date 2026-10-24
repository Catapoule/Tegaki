// Reconnaissance de kanji manuscrits, hors ligne.
// Principe : chaque trait dessiné est rééchantillonné (K points), le tout est normalisé dans
// une boîte 0..255 (ratio conservé), puis comparé aux tracés de référence KanjiVG par une
// programmation dynamique qui tolère un trait en trop ou manquant. L'ordre des traits compte.

export const K = 16;
export const BOX = 255;
const MIN_SPAN = 0.12;   // fraction de la zone de dessin (équivalent de MIN_SPAN côté Python)

const SKIP = 62;         // coût d'un trait ajouté / oublié (unités de la boîte 0..255)
const BAND = 2;          // écart max de nombre de traits entre le dessin et le modèle
const SHAPE_W = 0.35;    // poids de la forme seule (indépendante de la position) dans le coût d'un trait

export function resample(pts, n = K) {
  if (pts.length === 1) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
  const seg = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    seg.push(d); total += d;
  }
  if (total < 1e-9) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
  const out = [];
  let j = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < seg.length - 1 && acc + seg[j] < target) { acc += seg[j]; j++; }
    const f = seg[j] === 0 ? 0 : Math.min(1, Math.max(0, (target - acc) / seg[j]));
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f]);
  }
  return out;
}

// strokes : tableau de traits, chaque trait = tableau de [x, y] en fraction de la zone de dessin (0..1)
// retourne un tableau de Float32Array(2K) dans la boîte 0..255
export function normalize(strokes) {
  const res = strokes.map((s) => resample(s));
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const s of res) for (const [x, y] of s) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  const span = Math.max(maxx - minx, maxy - miny, MIN_SPAN);
  const sc = BOX / span, cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  return res.map((s) => {
    const a = new Float32Array(K * 2);
    for (let k = 0; k < K; k++) {
      a[2 * k] = (s[k][0] - cx) * sc + BOX / 2;
      a[2 * k + 1] = (s[k][1] - cy) * sc + BOX / 2;
    }
    return a;
  });
}

export class Recognizer {
  // entries : tableau de fiches {s: nb de traits, f: rang de fréquence}, buffer : strokes.bin (même ordre)
  constructor(entries, buffer) {
    this.entries = entries;
    this.pts = new Uint8Array(buffer);
    this.off = new Uint32Array(entries.length);
    let o = 0;
    entries.forEach((e, i) => { this.off[i] = o; o += e.s; });
    this.prior = new Float32Array(entries.length);
    entries.forEach((e, i) => {
      // léger avantage aux kanji courants, pour départager des tracés proches
      this.prior[i] = !e.f ? 5 : e.f <= 500 ? 0 : e.f <= 1500 ? 1 : e.f <= 2500 ? 2 : 3.5;
    });
  }

  strokeCost(u, ri) {
    const base = ri * K * 2;
    const p = this.pts;
    let pos = 0, ucx = 0, ucy = 0, rcx = 0, rcy = 0;
    for (let k = 0; k < K; k++) {
      const ux = u[2 * k], uy = u[2 * k + 1], rx = p[base + 2 * k], ry = p[base + 2 * k + 1];
      const dx = ux - rx, dy = uy - ry;
      pos += Math.sqrt(dx * dx + dy * dy);
      ucx += ux; ucy += uy; rcx += rx; rcy += ry;
    }
    ucx /= K; ucy /= K; rcx /= K; rcy /= K;
    let shape = 0;
    for (let k = 0; k < K; k++) {
      const sx = u[2 * k] - ucx - (p[base + 2 * k] - rcx), sy = u[2 * k + 1] - ucy - (p[base + 2 * k + 1] - rcy);
      shape += Math.sqrt(sx * sx + sy * sy);
    }
    return ((1 - SHAPE_W) * pos + SHAPE_W * shape) / K;
  }

  // Distance entre le dessin (n traits normalisés) et le kanji i.
  // `bound` : si le coût partiel dépasse déjà ce seuil (déjà trop loin du top), on abandonne.
  distance(user, i, bound = Infinity) {
    const nu = user.length, nr = this.entries[i].s, r0 = this.off[i];
    const norm = Math.max(nu, nr);
    const cap = bound * norm;
    const INF = 1e9;
    let prev = new Float32Array(nr + 1), cur = new Float32Array(nr + 1);
    for (let j = 0; j <= nr; j++) prev[j] = j * SKIP;
    for (let a = 1; a <= nu; a++) {
      cur[0] = a * SKIP;
      let rowMin = cur[0];
      for (let j = 1; j <= nr; j++) {
        if (Math.abs(a - j) > BAND + 1) { cur[j] = INF; continue; }
        const sub = prev[j - 1] + this.strokeCost(user[a - 1], r0 + j - 1);
        const del = prev[j] + SKIP;
        const ins = cur[j - 1] + SKIP;
        const v = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > cap) return Infinity;
      const t = prev; prev = cur; cur = t;
    }
    return prev[nr] / norm;
  }

  // strokes : traits bruts en fraction (0..1). Retourne [{i, score}] triés (meilleur d'abord).
  recognize(strokes, limit = 24) {
    if (!strokes.length) return [];
    const user = normalize(strokes);
    const nu = user.length;
    // On garde les `limit` meilleurs ; dès que la liste est pleine, le pire score sert de seuil d'abandon.
    const best = [];
    let thr = Infinity;
    for (let i = 0; i < this.entries.length; i++) {
      if (Math.abs(this.entries[i].s - nu) > BAND) continue;
      const d = this.distance(user, i, thr - this.prior[i]);
      if (d === Infinity) continue;
      const score = d + this.prior[i];
      if (score >= thr) continue;
      let k = best.length;
      best.push({ i, score });
      while (k > 0 && best[k - 1].score > score) { best[k] = best[k - 1]; k--; }
      best[k] = { i, score };
      if (best.length > limit) best.pop();
      if (best.length === limit) thr = best[limit - 1].score;
    }
    return best;
  }
}
