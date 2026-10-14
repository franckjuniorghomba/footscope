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
  rejected: 0,
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

// Les champs viennent d'un JSON public : seuls les types attendus sont convertis, pour qu'un
// objet inattendu (`{"toString":null}`) ne puisse jamais lever d'exception.
const positiveId = (v) => {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const text = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const label = (v) => text(typeof v === 'number' && Number.isFinite(v) ? String(v) : v, 40);
const isoTime = (v) => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const validOdd = (v) => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^\d{1,6}(?:\.\d{1,4})?$/.test(s) && Number(s) > 1 ? s : null;
};
const bytes = (s) => new TextEncoder().encode(s).length;

// Ne garde que les marchés gérés, sans jamais compléter une valeur absente.
function compactBookmaker(book) {
  const name = text(book?.name);
  if (!name || !Array.isArray(book.bets)) return null;
  const markets = [];
  for (const bet of book.bets) {
    if (typeof bet?.name !== 'string' || !supportedMarkets.has(bet.name)) continue;
    if (!Array.isArray(bet.values) || markets.some((m) => m.name === bet.name)) continue;
    const values = [];
    for (const v of bet.values.slice(0, ARCHIVE_MAX_VALUES)) {
      const odd = validOdd(v?.odd),
        value = label(v?.value);
      if (odd && value) values.push({ value, odd });
    }
    if (values.length) markets.push({ name: bet.name, values });
  }
  return markets.length ? { id: positiveId(book.id), name, markets } : null;
}

// Clé ne dépendant que de (fixtureId, update) : le jour est celui du relevé en GMT−5 fixe, pour
// qu'un coup d'envoi absent, déplacé ou corrigé ne crée jamais une deuxième écriture.
export const archiveKey = (fixtureId, update) =>
  ARCHIVE_PREFIX +
  fixedDay(update) +
  '/' +
  fixtureId +
  '/' +
  update.replace(/[-:.]/g, '') +
  '.json';

export function archiveRecord(row, query, retrievedAt) {
  const fixtureId = positiveId(row?.fixture?.id);
  const update = isoTime(row?.update);
  if (!fixtureId || !update) return null;
  const bookmakers = (Array.isArray(row.bookmakers) ? row.bookmakers : [])
    .map(compactBookmaker)
    .filter(Boolean);
  if (!bookmakers.length) return null;
  const record = {
    version: 1,
    fixtureId,
    league: {
      id: positiveId(row.league?.id),
      name: text(row.league?.name),
      country: text(row.league?.country),
      season: positiveId(row.league?.season),
    },
    kickoff: isoTime(row.fixture.date),
    update,
    retrievedAt: text(retrievedAt, 40),
    query: text(query, 200),
    truncated: false,
    droppedBookmakers: 0,
    bookmakers: [],
  };
  // Plafond de taille : on retire les derniers bookmakers et on le signale, plutôt que
  // d'écrire un objet démesuré ou de perdre tout le relevé. Chaque bookmaker n'est sérialisé
  // qu'une fois : le coût reste linéaire même pour un relevé très volumineux.
  const kept = bookmakers.slice(0, ARCHIVE_MAX_BOOKMAKERS);
  const parts = kept.map((b) => JSON.stringify(b));
  let size = parts.reduce((n, p) => n + bytes(p), 0) + Math.max(parts.length - 1, 0);
  const envelope = () => {
    record.droppedBookmakers = bookmakers.length - parts.length;
    record.truncated = record.droppedBookmakers > 0;
    return bytes(JSON.stringify(record));
  };
  while (parts.length && envelope() + size > ARCHIVE_MAX_BYTES) {
    size -= bytes(parts.pop()) + (parts.length ? 1 : 0);
  }
  if (!parts.length) return null;
  record.bookmakers = kept.slice(0, parts.length);
  const body = JSON.stringify(record);
  if (bytes(body) > ARCHIVE_MAX_BYTES) return null;
  return { key: archiveKey(fixtureId, update), body, truncated: record.truncated };
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
    failed('écriture impossible', e);
  }
}

// Seul le type d'erreur est journalisé : aucune valeur de requête, de réponse ni de configuration.
function failed(message, e) {
  lastFailureAt = new Date().toISOString();
  const name = typeof e?.name === 'string' && /^\w{1,40}$/.test(e.name) ? e.name : 'Error';
  console.warn('Archive des cotes : ' + message + ' (' + name + ').');
}

// Appelée seulement par api() après une réponse réseau réussie, hors du chemin de la réponse
// (`waitUntil` ou promesse détachée). Ne rejette jamais et se termine au plus tard après
// ARCHIVE_TIMEOUT_MS. Les relevés sont construits avant la première attente : l'archive lit
// la réponse telle que le fournisseur l'a donnée, avant tout usage par l'analyse.
export async function archiveOdds(env, path, data) {
  try {
    if (!env?.BUCKET || !String(path).startsWith('odds?') || !Array.isArray(data?.response)) return;
    metrics.responses++;
    const rows = data.response.slice(0, ARCHIVE_MAX_ROWS);
    metrics.skipped += data.response.length - rows.length;
    const records = [];
    for (const row of rows) {
      // Une ligne mal formée est écartée seule : elle n'empêche pas d'archiver les autres.
      let record = null;
      try {
        record = archiveRecord(row, path, data.retrievedAt);
      } catch (e) {
        metrics.rejected++;
        failed('relevé illisible écarté', e);
        continue;
      }
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
  } catch (e) {
    metrics.failures++;
    failed('archivage interrompu', e);
  }
}
