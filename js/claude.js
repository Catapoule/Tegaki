// Génération d'une histoire mnémotechnique avec l'API Claude, appelée directement depuis le navigateur.
// Usage personnel uniquement : la clé est stockée sur l'appareil. Pour partager l'appli, passe par un petit serveur relais.

const SYSTEM = [
  "Tu aides un francophone à mémoriser des kanji.",
  "Écris en français une histoire mnémotechnique courte (2 à 4 phrases), visuelle et concrète,",
  "qui relie les composants au sens du kanji. Pas de préambule ni de titre.",
  "Si le sens est ambigu, privilégie le premier sens donné.",
  "Termine par une ligne commençant par « Lecture : » avec un jeu de mots en français pour retenir la lecture on'yomi principale, si elle existe."
].join(' ');

export function buildPrompt(entry, parts) {
  const sens = (entry.fr?.length ? entry.fr : entry.en || []).join(', ');
  const lines = [
    `Kanji : ${entry.c} (${entry.s} traits)`,
    `Sens : ${sens}`,
  ];
  if (entry.on?.length) lines.push(`Lectures on : ${entry.on.join(', ')}`);
  if (entry.kun?.length) lines.push(`Lectures kun : ${entry.kun.join(', ')}`);
  if (parts.length) {
    lines.push('Composants : ' + parts.map((p) => p.gloss ? `${p.glyph} (${p.gloss})` : p.glyph).join(' + '));
  } else {
    lines.push('Composants : aucun (kanji simple, imagine le dessin ou le geste représenté)');
  }
  return lines.join('\n');
}

export async function proposeMnemonic(entry, parts, { key, model }) {
  if (!key) throw new Error('Ajoute ta clé d\'API dans les réglages.');
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-5-5',
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: 'user', content: buildPrompt(entry, parts) }],
      }),
    });
  } catch {
    throw new Error('Pas de connexion. La génération a besoin du réseau ; le reste de l\'appli fonctionne hors ligne.');
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Clé d\'API refusée. Vérifie-la dans les réglages.');
    if (res.status === 404) throw new Error('Modèle introuvable. Vérifie son nom dans les réglages.');
    if (res.status === 429) throw new Error('Trop de requêtes, réessaie dans un instant.');
    throw new Error(`Erreur du service (${res.status}).`);
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('Réponse vide, réessaie.');
  return text;
}
