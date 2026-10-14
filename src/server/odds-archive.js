import { supportedMarkets } from './coupon.js';
import { fixedDay } from './provider.js';

// Historique des cotes (BIS-192) : chaque réponse `odds` réellement reçue du fournisseur est
// archivée, un objet R2 par (match, relevé `update`). Aucun appel au fournisseur n'est ajouté,
// et les succès de cache n'arrivent jamais ici. L'archive ne contient que des données publiques
// du fournisseur : ni clé, ni identité de visiteur.
export const ARCHIVE_PREFIX = 'odds-archive/';
export const ARCHIVE_MAX_BYTES = 32768;
const ARCHIVE_MAX_ROWS = 100,
  ARCHIVE_MAX_BOOKMAKERS = 40,
  ARCHIVE_MAX_VALUES = 40,
  ARCHIVE_SEEN = 5000;
var ARCHIVE_TIMEOUT_MS = 2000;
const seen = new Map();
let metricsSince = new Date().toISOString();
const counters = () => ({
  responses: 0,
  written: 0,
  duplicates: 0,
  truncated: 0,
  skipped: 0,
  failures: 0,
  timeouts: 0,
});
let metrics = counters(),
  lastFailureAt = null;

export function archiveMetrics() {
  return { scope: 'isolat', since: metricsSince, ...metrics, lastFailureAt };
}
export function resetArchiveMetrics() {
  metrics = counters();
  lastFailureAt = null;
  seen.clear();
  metricsSince = new Date().toISOString();
}

const positiveId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const text = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const validOdd = (v) => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^\d{1,6}(?:\.\d{1,4})?$/.test(s) && Number(s) > 1 ? s : null;
};

// Ne garde que les marchés gérés, sans jamais compléter une valeur absente.
function compactBookmaker(book) {
  const name = text(book?.name);
  if (!name || !Array.isArray(book.bets)) return null;
  const markets = [];
  for (const bet of book.bets) {
    if (!supportedMarkets.has(bet?.name) || !Array.isArray(bet.values)) continue;
    if (markets.some((m) => m.name === bet.name)) continue;
    const values = [];
    for (const v of bet.values.slice(0, ARCHIVE_MAX_VALUES)) {
      const odd = validOdd(v?.odd),
        value = text(String(v?.value ?? ''), 40);
      if (odd && value) values.push({ value, odd });
    }
    if (values.length) markets.push({ name: bet.name, values });
  }
  return markets.length ? { id: positiveId(book.id), name, markets } : null;
}

export function archiveRecord(row, query, retrievedAt) {
  const fixtureId = positiveId(row?.fixture?.id);
  const updated = typeof row?.update === 'string' ? Date.parse(row.update) : NaN;
  if (!fixtureId || !Number.isFinite(updated)) return null;
  const kickoffMs = Date.parse(row.fixture.date || '');
  const kickoff = Number.isFinite(kickoffMs) ? new Date(kickoffMs).toISOString() : null;
  const bookmakers = (Array.isArray(row.bookmakers) ? row.bookmakers : [])
    .map(compactBookmaker)
    .filter(Boolean);
  if (!bookmakers.length) return null;
  const update = new Date(updated).toISOString();
  const record = {
    version: 1,
    fixtureId,
    league: {
      id: positiveId(row.league?.id),
      name: text(row.league?.name),
      country: text(row.league?.country),
      season: positiveId(row.league?.season),
    },
    kickoff,
    update,
    retrievedAt: text(retrievedAt, 40),
    query: String(query).slice(0, 200),
    truncated: false,
    droppedBookmakers: 0,
    bookmakers: bookmakers.slice(0, ARCHIVE_MAX_BOOKMAKERS),
  };
  record.droppedBookmakers = bookmakers.length - record.bookmakers.length;
  // Plafond de taille : on retire les derniers bookmakers et on le signale, plutôt que
  // d'écrire un objet démesuré ou de perdre tout le relevé.
  record.truncated = record.droppedBookmakers > 0;
  let body = JSON.stringify(record);
  while (new TextEncoder().encode(body).length > ARCHIVE_MAX_BYTES) {
    if (record.bookmakers.length <= 1) return null;
    record.bookmakers.pop();
    record.droppedBookmakers++;
    record.truncated = true;
    body = JSON.stringify(record);
  }
  const key =
    ARCHIVE_PREFIX +
    fixedDay(kickoff || update) +
    '/' +
    fixtureId +
    '/' +
    update.replace(/[-:.]/g, '') +
    '.json';
  return { key, body, truncated: record.truncated };
}

async function writeOne(env, { key, body, truncated }) {
  if (seen.has(key)) {
    metrics.duplicates++;
    return;
  }
  try {
    // Écriture conditionnelle : un relevé déjà archivé, même par un autre serveur, n'est pas
    // réécrit.
    const written = await env.BUCKET.put(key, body, {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'application/json' },
    });
    seen.set(key, true);
    if (seen.size > ARCHIVE_SEEN) seen.delete(seen.keys().next().value);
    if (written === null) metrics.duplicates++;
    else {
      metrics.written++;
      if (truncated) metrics.truncated++;
    }
  } catch (e) {
    metrics.failures++;
    lastFailureAt = new Date().toISOString();
    // Seul le type d'erreur est journalisé : aucune valeur de requête ni de configuration.
    console.warn('Archive des cotes : écriture impossible (' + (e?.name || 'Error') + ').');
  }
}

// Appelée seulement par api() après une réponse réseau réussie. Ne rejette jamais et rend la
// main au plus tard après ARCHIVE_TIMEOUT_MS, pour ne pas ralentir l'analyse.
export async function archiveOdds(env, path, data) {
  if (!env.BUCKET || !String(path).startsWith('odds?') || !Array.isArray(data?.response)) return;
  metrics.responses++;
  const rows = data.response.slice(0, ARCHIVE_MAX_ROWS);
  metrics.skipped += data.response.length - rows.length;
  const records = [];
  for (const row of rows) {
    const record = archiveRecord(row, path, data.retrievedAt);
    if (record) records.push(record);
    else metrics.skipped++;
  }
  if (!records.length) return;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ARCHIVE_TIMEOUT_MS);
  });
  const done = Promise.all(records.map((r) => writeOne(env, r)));
  if ((await Promise.race([done, timeout])) === 'timeout') {
    metrics.timeouts++;
    lastFailureAt = new Date().toISOString();
  }
  clearTimeout(timer);
}
