import { Recognizer, K, BOX } from './recognizer.js';
import * as store from './store.js';
import { proposeMnemonic } from './claude.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const wide = () => matchMedia('(min-width: 900px)').matches;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let entries = [];           // fiches (kanji.json)
let rec = null;             // Recognizer
const byChar = new Map();   // "語" -> indice
let current = -1;           // fiche ouverte

/* ------------------------------------------------------------------ données */

async function loadData() {
  const [meta, buf] = await Promise.all([
    fetch('data/kanji.json').then((r) => r.json()),
    fetch('data/strokes.bin').then((r) => r.arrayBuffer()),
  ]);
  if (meta.k !== K) throw new Error('Données incompatibles avec le moteur');
  entries = meta.kanji;
  entries.forEach((e, i) => byChar.set(e.c, i));
  rec = new Recognizer(entries, buf);
}

const gloss = (e, n = 3) => (e.fr?.length ? e.fr : e.en || []).slice(0, n).join(', ');
const baseGloss = (c) => { const i = byChar.get(c); return i === undefined ? '' : gloss(entries[i], 1); };

/* ------------------------------------------------------------------ onglets */

const TABS = ['draw', 'search', 'mine'];
function showTab(name) {
  for (const t of TABS) {
    $('#tab-' + t).setAttribute('aria-selected', String(t === name));
    $('#view-' + t).hidden = t !== name;
  }
  if (name === 'mine') renderMine();
  if (name === 'search') $('#q').focus({ preventScroll: true });
}
TABS.forEach((t) => $('#tab-' + t).addEventListener('click', () => showTab(t)));

/* ------------------------------------------------------------------ zone de dessin */

class Pad {
  constructor(canvas, onChange) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.strokes = []; this.cur = null; this.pid = null;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, (e) => this.up(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.draw());
  }
  resize() {
    const r = this.cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
    this.size = r.width; this.dpr = dpr;
    this.draw();
  }
  pt(e) {
    const r = this.cv.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }
  down(e) {
    if (this.pid !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this.pid = e.pointerId; this.cv.setPointerCapture(e.pointerId);
    this.cur = [this.pt(e)]; this.draw();
  }
  move(e) {
    if (e.pointerId !== this.pid) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) this.cur.push(this.pt(ev));
    this.draw();
  }
  up(e) {
    if (e.pointerId !== this.pid) return;
    this.pid = null;
    if (this.cur) this.strokes.push(this.cur);
    this.cur = null; this.draw(); this.onChange();
  }
  undo() { this.strokes.pop(); this.draw(); this.onChange(); }
  clear() { this.strokes = []; this.cur = null; this.draw(); this.onChange(); }
  draw() {
    const { ctx, cv, dpr = 1 } = this, W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // repères : croix centrale et cadre (comme du papier genkō yōshi)
    ctx.strokeStyle = css('--line'); ctx.lineWidth = Math.max(1, dpr);
    ctx.setLineDash([6 * dpr, 6 * dpr]);
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = css('--ink'); ctx.fillStyle = css('--ink'); ctx.lineWidth = Math.max(4, W * 0.035);
    const all = this.cur ? [...this.strokes, this.cur] : this.strokes;
    for (const s of all) {
      const p = s.map(([x, y]) => [x * W, y * H]);
      if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], ctx.lineWidth / 2, 0, 7); ctx.fill(); continue; }
      ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
        ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
      }
      ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]); ctx.stroke();
    }
  }
}

let recogTimer = 0;
const pad = new Pad($('#pad'), () => {
  const n = pad.strokes.length;
  $('#btn-undo').disabled = !n; $('#btn-clear').disabled = !n;
  $('#pad-empty').hidden = n > 0;
  clearTimeout(recogTimer);
  recogTimer = setTimeout(runRecognition, 120);
});
$('#btn-undo').addEventListener('click', () => pad.undo());
$('#btn-clear').addEventListener('click', () => pad.clear());
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, dialog')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); pad.undo(); }
  if (e.key === 'Escape' && !wide()) closeDetail();
});

function runRecognition() {
  const n = pad.strokes.length, list = $('#cands');
  $('#cands-label').hidden = !n; $('#draw-tip').hidden = n > 0;
  list.textContent = '';
  if (!n) { setStatus(rec ? 'Prêt' : 'Chargement des données…'); return; }
  if (!rec) return;
  const t0 = performance.now();
  const res = rec.recognize(pad.strokes, 24);
  const ms = Math.round(performance.now() - t0);
  setStatus(`${n} trait${n > 1 ? 's' : ''} · ${ms} ms`);
  for (const { i } of res) {
    const e = entries[i];
    const li = document.createElement('li');
    li.innerHTML = `<button class="cand" data-i="${i}"><span class="cand-glyph" lang="ja">${esc(e.c)}</span><span class="cand-gloss">${esc(gloss(e, 1))}</span></button>`;
    list.append(li);
  }
}
const setStatus = (t) => { $('#pad-status').textContent = t; };
$('#cands').addEventListener('click', (e) => {
  const b = e.target.closest('.cand'); if (b) openDetail(Number(b.dataset.i));
});

/* ------------------------------------------------------------------ recherche & liste perso */

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

function search(q) {
  q = q.trim();
  if (!q) return [];
  const direct = [...new Set([...q])].filter((ch) => byChar.has(ch)).map((ch) => byChar.get(ch));
  if (direct.length) return direct;
  const n = norm(q), kana = toHira(q), hits = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    e._n ??= [...(e.fr || []), ...(e.en || [])].map(norm);
    let best = 0;
    for (const m of e._n) {
      if (m === n) best = 4;
      else if (best < 3 && m.split(/[^a-z0-9]+/).includes(n)) best = 3;
      else if (best < 2 && m.startsWith(n)) best = 2;
      else if (best < 1 && n.length > 1 && m.includes(n)) best = 1;
    }
    if (/[぀-ヿ]/.test(q)) {
      for (const r of [...(e.on || []), ...(e.kun || [])]) {
        const rr = toHira(r).replace(/[.\-]/g, '');
        if (rr === kana) best = Math.max(best, 4); else if (rr.startsWith(kana)) best = Math.max(best, 1);
      }
    }
    if (best) hits.push([i, best]);
  }
  hits.sort((a, b) => b[1] - a[1] || (entries[a[0]].f || 99999) - (entries[b[0]].f || 99999));
  return hits.map((h) => h[0]);
}

function rowHTML(i, flag = '') {
  const e = entries[i];
  const read = [...(e.on || []).slice(0, 2), ...(e.kun || []).slice(0, 2)].join('　');
  return `<li><button class="row" data-i="${i}">
    <span class="row-glyph" lang="ja">${esc(e.c)}</span>
    <span class="row-main"><span class="row-gloss">${esc(gloss(e, 3))}</span><span class="row-read" lang="ja">${esc(read)}</span></span>
    <span class="row-flag">${flag}</span></button></li>`;
}

function renderSearch() {
  if (!rec) return;
  const q = $('#q').value;
  const idx = search(q);
  $('#search-count').textContent = q.trim() ? (idx.length ? `${idx.length} résultat${idx.length > 1 ? 's' : ''}${idx.length > 60 ? ' (60 affichés)' : ''}` : 'Aucun résultat') : '';
  $('#search-results').innerHTML = idx.slice(0, 60).map((i) => rowHTML(i, store.getNote(entries[i].c).fav ? '★' : '')).join('');
}
$('#q').addEventListener('input', renderSearch);
$('#search-results').addEventListener('click', (e) => { const b = e.target.closest('.row'); if (b) openDetail(Number(b.dataset.i)); });
$('#mine-results').addEventListener('click', (e) => { const b = e.target.closest('.row'); if (b) openDetail(Number(b.dataset.i)); });

function renderMine() {
  if (!rec) return;
  const notes = store.listNotes().filter((n) => byChar.has(n.c));
  $('#mine-count').textContent = notes.length ? `${notes.length} kanji enregistré${notes.length > 1 ? 's' : ''}` : 'Rien pour l\'instant. Ouvre une fiche, écris une histoire ou touche l\'étoile.';
  $('#mine-results').innerHTML = notes.map((n) => rowHTML(byChar.get(n.c), (n.fav ? '★ ' : '') + (n.m ? '✎' : ''))).join('');
  for (const id of ['btn-anki', 'btn-backup']) $('#' + id).disabled = !notes.length;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
$('#btn-anki').addEventListener('click', () => {
  const rows = store.listNotes().filter((n) => byChar.has(n.c)).map((n) => {
    const e = entries[byChar.get(n.c)];
    const clean = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ');
    return [e.c, (e.fr?.length ? e.fr : e.en || []).join(', '), (e.on || []).join('、'), (e.kun || []).join('、'),
      (e.p || []).map((p) => p[0]).join(' + '), clean(n.m)].join('\t');
  });
  download('tegaki-anki.txt', '#separator:tab\n#html:false\n' + rows.join('\n') + '\n', 'text/tab-separated-values');
});
$('#btn-backup').addEventListener('click', () => download('tegaki-sauvegarde.json', store.exportBackup(), 'application/json'));
$('#file-import').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const n = store.importBackup(await f.text()); renderMine(); $('#mine-count').textContent = `${n} fiche${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''}`; }
  catch { $('#mine-count').textContent = 'Import impossible : fichier non reconnu.'; }
});

/* ------------------------------------------------------------------ fiche */

const detail = $('#detail'), inner = $('#detail-inner');
let animToken = 0;

function partsOf(e) {
  return (e.p || []).map(([glyph, base]) => ({ glyph, base: base || glyph, gloss: baseGloss(base || glyph), known: byChar.has(base || glyph) }));
}

function openDetail(i, push = true) {
  current = i;
  const e = entries[i], parts = partsOf(e), note = store.getNote(e.c);
  const meanings = e.fr?.length
    ? `<div class="d-fr">${esc(e.fr.join(', '))}</div>${e.en?.length ? `<div class="d-en">EN : ${esc(e.en.join(', '))}</div>` : ''}`
    : `<div class="d-fr">${esc((e.en || []).join(', '))}<span class="badge" title="Pas de traduction française dans KANJIDIC2 pour ce kanji">EN</span></div>`;
  const chips = [`${e.s} trait${e.s > 1 ? 's' : ''}`];
  if (e.g) chips.push(e.g <= 6 ? `Jōyō, ${e.g}ᵉ année` : 'Jōyō (collège+)');
  if (e.j) chips.push(`JLPT (ancien niveau ${e.j})`);
  if (e.f) chips.push(`fréquence n° ${e.f}`);
  const fmt = (arr) => arr.map((r) => esc(r.replace('.', '·'))).join('　');
  const recipe = parts.length
    ? `<p class="recipe"><b lang="ja">${esc(e.c)}</b> = ${parts.map((p) => `<b lang="ja">${esc(p.glyph)}</b>${p.gloss ? ' (' + esc(p.gloss) + ')' : ''}`).join(' + ')}</p>`
    : `<p class="recipe muted">Kanji simple, sans composant : cherche le dessin ou le geste qu'il représente.</p>`;

  inner.innerHTML = `
    <div class="d-bar">
      <button class="btn d-close" id="d-close">← Retour</button>
      <span class="spacer"></span>
      <button class="icon-btn fav" id="d-fav" aria-pressed="${note.fav}" aria-label="Favori" title="Favori">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 17l-5.3 2.9 1.1-5.9L3.4 9.9l6-.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div class="d-hero">
      <div class="d-glyph" lang="ja">${esc(e.c)}</div>
      <div class="d-meanings">${meanings}</div>
    </div>
    <div class="d-section">
      <dl class="readings" lang="ja">
        ${e.on?.length ? `<dt>On</dt><dd>${fmt(e.on)}</dd>` : ''}
        ${e.kun?.length ? `<dt>Kun</dt><dd>${fmt(e.kun)}</dd>` : ''}
      </dl>
      <div class="meta">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
    </div>
    <div class="d-section anim-card">
      <h3 style="justify-self:start">Ordre des traits</h3>
      <div class="anim-box"><canvas id="anim"></canvas></div>
      <button class="btn" id="d-replay">Rejouer</button>
    </div>
    <div class="d-section">
      <h3>Composants</h3>
      ${parts.length ? `<div class="parts">${parts.map((p) => `<button class="part" data-c="${esc(p.base)}" ${p.known ? '' : 'disabled'}>
          <span class="part-glyph" lang="ja">${esc(p.glyph)}</span><span class="part-gloss">${esc(p.gloss || '—')}</span>
          ${p.glyph !== p.base ? `<span class="part-base">variante de ${esc(p.base)}</span>` : ''}</button>`).join('')}</div>` : '<p class="muted small" style="margin:0">Aucun.</p>'}
    </div>
    <div class="d-section">
      <h3>Mnémonique</h3>
      ${recipe}
      <textarea class="mnemo" id="d-mnemo" rows="5" placeholder="Écris ton histoire : une image, une scène, un jeu de mots…" aria-label="Histoire mnémotechnique">${esc(note.m)}</textarea>
      <div class="mnemo-actions">
        <button class="btn btn-primary" id="d-gen">Proposer avec Claude</button>
        <span class="mnemo-note" id="d-note" role="status" aria-live="polite">${note.m ? 'Enregistré sur cet appareil' : ''}</span>
      </div>
    </div>`;
  detail.setAttribute('aria-hidden', 'false');
  detail.scrollTop = 0;
  if (!wide()) {
    if (!detail.classList.contains('open') && push) history.pushState({ detail: true }, '');
    detail.classList.add('open');
  }
  playStrokes(i, false);
}

function closeDetail() {
  if (wide()) return;
  if (history.state?.detail) history.back(); else hideDetail();
}
function hideDetail() {
  detail.classList.remove('open'); detail.setAttribute('aria-hidden', 'true'); animToken++;
}
addEventListener('popstate', () => { if (!history.state?.detail) hideDetail(); });
// Un rechargement garde l'état d'historique : on le remet à zéro pour que « Retour » referme bien la fiche.
if (history.state?.detail) history.replaceState(null, '');

inner.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button'); if (!t || current < 0) return;
  const e = entries[current];
  if (t.id === 'd-close') closeDetail();
  else if (t.id === 'd-replay') playStrokes(current, true);
  else if (t.id === 'd-fav') {
    const fav = t.getAttribute('aria-pressed') !== 'true';
    store.setNote(e.c, { fav }); t.setAttribute('aria-pressed', String(fav));
  } else if (t.classList.contains('part')) openDetail(byChar.get(t.dataset.c), false);
  else if (t.id === 'd-gen') generate(t);
});

let saveTimer = 0;
inner.addEventListener('input', (ev) => {
  if (ev.target.id !== 'd-mnemo') return;
  const c = entries[current].c, v = ev.target.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ok = store.setNote(c, { m: v });
    const n = $('#d-note'); if (n) { n.className = 'mnemo-note' + (ok ? '' : ' err'); n.textContent = ok ? 'Enregistré sur cet appareil' : 'Stockage local indisponible : histoire non enregistrée'; }
  }, 400);
});

async function generate(btn) {
  const e = entries[current], note = $('#d-note'), ta = $('#d-mnemo'), s = store.getSettings();
  if (!s.key) { note.className = 'mnemo-note err'; note.textContent = 'Ajoute ta clé d\'API dans les réglages (roue dentée).'; $('#dlg-settings').showModal(); return; }
  if (ta.value.trim() && !confirm('Remplacer ton texte actuel par la proposition ?')) return;
  btn.disabled = true; note.className = 'mnemo-note'; note.textContent = 'Claude écrit…';
  try {
    const text = await proposeMnemonic(e, partsOf(e), s);
    if (entries[current] !== e) return;
    ta.value = text; store.setNote(e.c, { m: text });
    note.textContent = 'Proposition enregistrée, modifie-la à ta guise';
  } catch (err) {
    note.className = 'mnemo-note err'; note.textContent = err.message;
  } finally { btn.disabled = false; }
}

/* Animation de l'ordre des traits, à partir des tracés de référence */
function playStrokes(i, animate) {
  const cv = $('#anim'); if (!cv) return;
  const e = entries[i], token = ++animToken;
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  const ctx = cv.getContext('2d'), W = cv.width, pad = W * 0.07, sc = (W - 2 * pad) / BOX;
  const off = rec.off[i];
  const strokes = [];
  for (let s = 0; s < e.s; s++) {
    const pts = [];
    for (let k = 0; k < K; k++) {
      const o = (off + s) * K * 2 + 2 * k;
      pts.push([pad + rec.pts[o] * sc, pad + rec.pts[o + 1] * sc]);
    }
    strokes.push(pts);
  }
  const ink = css('--ink'), mark = css('--mark'), line = css('--line');
  const lw = Math.max(3, W * 0.03);
  const path = (p, upto = 1) => {
    // dessine la polyligne lissée jusqu'à la fraction `upto` de sa longueur
    const n = (p.length - 1) * upto, full = Math.floor(n), f = n - full;
    const q = p.slice(0, full + 1);
    if (full < p.length - 1) q.push([p[full][0] + (p[full + 1][0] - p[full][0]) * f, p[full][1] + (p[full + 1][1] - p[full][1]) * f]);
    ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]);
    for (let j = 1; j < q.length - 1; j++) ctx.quadraticCurveTo(q[j][0], q[j][1], (q[j][0] + q[j + 1][0]) / 2, (q[j][1] + q[j + 1][1]) / 2);
    if (q.length > 1) ctx.lineTo(q[q.length - 1][0], q[q.length - 1][1]);
    ctx.stroke();
  };
  const frame = (doneCount, partial) => {
    ctx.clearRect(0, 0, W, W);
    ctx.setLineDash([5 * dpr, 5 * dpr]); ctx.strokeStyle = line; ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, W); ctx.moveTo(0, W / 2); ctx.lineTo(W, W / 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw; ctx.strokeStyle = ink;
    for (let s = 0; s < doneCount; s++) path(strokes[s]);
    if (partial !== null && doneCount < strokes.length) path(strokes[doneCount], partial);
  };
  const numbers = () => {
    ctx.font = `700 ${Math.max(11, W * 0.065)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    strokes.forEach((p, s) => {
      const [x, y] = p[0], dx = x < W / 2 ? -1 : 1, dy = y < W / 2 ? -1 : 1;
      const cx = x + dx * W * 0.045, cy = y + dy * W * 0.045;
      ctx.fillStyle = mark; ctx.fillText(String(s + 1), Math.min(W - 8, Math.max(8, cx)), Math.min(W - 8, Math.max(8, cy)));
    });
  };
  if (!animate || reduceMotion()) { frame(strokes.length, null); numbers(); return; }
  const per = 520, t0 = performance.now();
  const tick = (now) => {
    if (token !== animToken) return;
    // le 1er horodatage de requestAnimationFrame peut précéder t0 : on borne à 0 pour ne jamais viser un trait inexistant
    const t = Math.max(0, now - t0) / per, s = Math.floor(t);
    if (s >= strokes.length) { frame(strokes.length, null); numbers(); return; }
    frame(s, t - s); requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ réglages */

const dlg = $('#dlg-settings');
$('#btn-settings').addEventListener('click', () => {
  const s = store.getSettings(); $('#set-key').value = s.key || ''; $('#set-model').value = s.model || '';
  dlg.showModal();
});
$('#form-settings').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'ok') store.setSettings({ key: $('#set-key').value.trim(), model: $('#set-model').value.trim() || 'claude-haiku-5-5' });
});

/* ------------------------------------------------------------------ démarrage */

async function boot() {
  $('#pad-empty').hidden = false;
  try {
    await loadData();
    setStatus('Prêt');
    if (pad.strokes.length) runRecognition();
    renderSearch();
  } catch (err) {
    console.error(err);
    setStatus('Données introuvables : lance l\'appli depuis un serveur web (voir README).');
  }
  // Sur mobile la fiche reste masquée tant qu'aucun kanji n'est choisi ; sur grand écran on affiche un message d'accueil.
  if (wide()) {
    detail.setAttribute('aria-hidden', 'false');
    inner.innerHTML = `<div class="detail-empty"><p>Dessine un kanji à gauche, puis choisis un candidat.<br>Sa fiche, ses composants et ton mnémonique s'afficheront ici.</p></div>`;
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
