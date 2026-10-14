import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeBudget } from '../scripts/backtest/budget.mjs';
import { readJson, repoRoot } from '../scripts/backtest/data.mjs';

// BIS-185 : le bloc copiable du README, extrait tel quel, s'arrête au premier échec,
// sans saisie ni appel, et conserve son code de sortie après la disparition de la clé.
const PREFIX = '/root/.local/share/jarvis/livrables/footscope';
const KEY = 'cle-simulee-bis185';
const readme = await readFile(join(repoRoot, 'scripts/backtest/README.md'), 'utf8');
const block = readme
  .split("### Commande à lancer par l'humain")[1]
  .split('```sh\n')[1]
  .split('```')[0];
assert(block.includes('read -rsp') && block.includes('collect.mjs --plan'));
assert.equal(block.split(PREFIX).length - 1, 3, 'Seuls les trois chemins sont remplacés');
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

const root = await mkdtemp(join(tmpdir(), 'footscope-readme-2026-'));
// Fournisseur simulé chargé dans chaque processus node du bloc : chaque fetch est journalisé.
const preload = join(root, 'fetch-simule.mjs');
await writeFile(
  preload,
  `import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
// Espacement de 6,5 s neutralisé : le fournisseur est simulé, seul l'ordre des appels compte.
createRequire(import.meta.url)('node:timers/promises').setTimeout = async () => {};
syncBuiltinESMExports();
import { providerResponse, seasonFixtures } from ${JSON.stringify(
    pathToFileURL(join(repoRoot, 'tests/fixtures/backtest-synthetic.mjs')).href,
  )};
globalThis.fetch = async (url, options) => {
  appendFileSync(process.env.FETCH_LOG, url + '\\n');
  if (options.headers['x-apisports-key'] !== ${JSON.stringify(KEY)}) throw Error('Clé inattendue');
  if (process.env.FETCH_REFUSE) return { ok: false, status: 403, json: async () => ({}) };
  const u = new URL(url);
  return providerResponse(
    seasonFixtures(Number(u.searchParams.get('league')), Number(u.searchParams.get('season')),
      Date.parse('2026-10-14T20:00:00Z')),
  );
};
`,
);
const stubs = {
  // pgrep répondant « collecteur actif ».
  active: { pgrep: '#!/bin/sh\nexit 0\n' },
  // Initialisation du registre en échec ; tout autre node est le vrai.
  initFails: {
    node: `#!/bin/sh\nif [ "$1" = scripts/backtest/budget.mjs ]; then echo 'Initialisation simulée en échec' >&2; exit 1; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  },
};

async function scenario(name, { input = KEY + '\n', archive, lock, stub, refuse, used = 30 }) {
  const dir = join(root, name);
  const base = join(dir, 'livrables');
  await mkdir(join(base, 'BIS-167'), { recursive: true });
  const budgetFile = join(base, 'BIS-167/budget-api-football.json');
  const archivePath = join(base, 'BIS-167/budget-api-football-bis167-30-appels.json');
  await initializeBudget({ budgetFile, used, reason: 'Registre partagé simulé' });
  const budgetBefore = await readFile(budgetFile, 'utf8');
  if (archive) await writeFile(archivePath, archive);
  if (lock) await writeFile(budgetFile + '.lock', '');
  const bin = join(dir, 'bin');
  await mkdir(bin);
  for (const [file, body] of Object.entries(stubs[stub] || {}))
    await writeFile(join(bin, file), body, { mode: 0o755 });
  const log = join(dir, 'fetch.log');
  await writeFile(log, '');
  // Bloc exact, chemins remplacés ; puis le shell appelant lit $? et la clé.
  const script = join(dir, 'bloc.sh');
  await writeFile(
    script,
    block.replaceAll(PREFIX, base) +
      'status=$?\necho "STATUT=$status CLE=${API_FOOTBALL_KEY:-absente}"\nexit $status\n',
  );
  const result = spawnSync('bash', [script], {
    cwd: repoRoot,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      API_FOOTBALL_KEY: '',
      PATH: `${bin}:${process.env.PATH}`,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      FETCH_LOG: log,
      ...(refuse && { FETCH_REFUSE: '1' }),
    },
  });
  const fetches = (await readFile(log, 'utf8')).split('\n').filter(Boolean).length;
  assert(!(result.stdout + result.stderr).includes(KEY), `${name} : clé affichée`);
  assert.match(result.stdout, new RegExp(`STATUT=${result.status} CLE=absente`), name);
  return { ...result, fetches, budgetFile, archivePath, budgetBefore, base };
}

try {
  // Échecs avant toute dépense : statut non nul, zéro fetch, archive intacte.
  const existing = 'ARCHIVE EXISTANTE : NE PAS ÉCRASER';
  const archived = await scenario('archive-existante', { archive: existing, used: 20 });
  assert.notEqual(archived.status, 0);
  assert.equal(archived.fetches, 0, 'Archive existante : aucun appel');
  assert.equal(await readFile(archived.archivePath, 'utf8'), existing);
  assert.equal(await readFile(archived.budgetFile, 'utf8'), archived.budgetBefore);

  const locked = await scenario('verrou-present', { lock: true });
  assert.notEqual(locked.status, 0);
  assert.equal(locked.fetches, 0, 'Verrou présent : aucun appel');
  assert(!(await exists(locked.archivePath)));
  assert.equal(await readFile(locked.budgetFile, 'utf8'), locked.budgetBefore);

  const active = await scenario('collecteur-actif', { stub: 'active' });
  assert.notEqual(active.status, 0);
  assert.equal(active.fetches, 0);
  assert(!(await exists(active.archivePath)));
  assert.match(active.stderr, /Collecteur actif/);

  const initFails = await scenario('initialisation-echouee', { stub: 'initFails' });
  assert.notEqual(initFails.status, 0);
  assert.equal(initFails.fetches, 0, 'Initialisation échouée : aucun appel');
  assert.match(initFails.stderr, /Initialisation simulée en échec/);
  assert.equal(await readFile(initFails.archivePath, 'utf8'), initFails.budgetBefore);
  assert(!(await exists(initFails.budgetFile)), 'Aucun registre recréé');

  for (const [name, input] of [
    ['saisie-echouee', ''],
    ['cle-vide', '\n'],
  ]) {
    const typed = await scenario(name, { input });
    assert.notEqual(typed.status, 0);
    assert.equal(typed.fetches, 0, `${name} : aucun appel`);
    assert.equal(await readFile(typed.archivePath, 'utf8'), typed.budgetBefore);
    const registry = await readJson(typed.budgetFile);
    assert.equal(registry.initialCalls, 20);
    assert.deepEqual(registry.attempts, []);
    assert(!(await exists(join(typed.base, 'BIS-185/api-football-2026'))));
  }

  // Refus du fournisseur : une tentative consommée, code d'échec conservé, clé effacée.
  const refused = await scenario('fournisseur-refuse', { refuse: true });
  assert.equal(refused.status, 1);
  assert.equal(refused.fetches, 1);
  assert.match(refused.stderr, /HTTP 403/);

  // Nominal : registre 30/30 archivé, initialisé à 20, exactement dix appels.
  const nominal = await scenario('nominal', {});
  assert.equal(nominal.status, 0, nominal.stderr);
  assert.equal(nominal.fetches, 10);
  assert.equal(await readFile(nominal.archivePath, 'utf8'), nominal.budgetBefore);
  const registry = await readJson(nominal.budgetFile);
  assert.equal(registry.initialCalls + registry.attempts.length, 30);
  const summary = JSON.parse(nominal.stdout.split('\n').find((line) => line.startsWith('{')));
  assert.equal(summary.calls, 10);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  'Passed: README authorization block stops at the first failure (existing archive, lock, active collector, failed init, failed or empty key) with 0 fetch, non-zero status and intact archive; nominal run makes exactly 10 calls.',
);
