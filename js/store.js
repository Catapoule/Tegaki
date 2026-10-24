// Stockage local : histoires mnémotechniques, favoris (sauvegardables) et réglages (jamais exportés).
const NOTES_KEY = 'tegaki:notes:v1';
const SETTINGS_KEY = 'tegaki:settings:v1';

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

let notes = read(NOTES_KEY, {});      // { "語": { m: "histoire", fav: true, t: 1730000000000 } }
let settings = read(SETTINGS_KEY, { key: '', model: 'claude-haiku-5-5' });

export const getNote = (c) => notes[c] || { m: '', fav: false };

export function setNote(c, patch) {
  const next = { ...getNote(c), ...patch, t: Date.now() };
  if (!next.m && !next.fav) delete notes[c]; else notes[c] = next;
  return write(NOTES_KEY, notes);
}

export const listNotes = () => Object.entries(notes)
  .map(([c, v]) => ({ c, ...v }))
  .sort((a, b) => (b.t || 0) - (a.t || 0));

export const getSettings = () => ({ ...settings });
export function setSettings(patch) {
  settings = { ...settings, ...patch };
  return write(SETTINGS_KEY, settings);
}

export const exportBackup = () => JSON.stringify({ app: 'tegaki', version: 1, notes }, null, 2);

export function importBackup(text) {
  const data = JSON.parse(text);
  if (!data || data.app !== 'tegaki' || typeof data.notes !== 'object') throw new Error('Fichier non reconnu');
  let n = 0;
  for (const [c, v] of Object.entries(data.notes)) {
    const mine = notes[c];
    // en cas de conflit, on garde la version la plus récente
    if (!mine || (v.t || 0) > (mine.t || 0)) { notes[c] = { m: String(v.m || ''), fav: !!v.fav, t: v.t || Date.now() }; n++; }
  }
  write(NOTES_KEY, notes);
  return n;
}
