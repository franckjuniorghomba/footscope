const $ = (s) => document.querySelector(s);
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// BIS-222 : la préférence explicite prime ; le système reste suivi sans choix enregistré.
function initTheme() {
  const button = $('#themeToggle');
  if (!button || typeof window === 'undefined' || !window.matchMedia) return;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = null;
  try {
    const saved = localStorage.getItem('footscope-theme');
    if (saved === 'light' || saved === 'dark') choice = saved;
  } catch {}
  const apply = () => {
    const dark = choice ? choice === 'dark' : system.matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    button.setAttribute('aria-pressed', String(dark));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#101916' : '#f5f4ef';
  };
  button.addEventListener('click', () => {
    choice = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('footscope-theme', choice);
    } catch {}
    apply();
  });
  system.addEventListener('change', apply);
  apply();
}
initTheme();
const tz = 'America/Toronto';
const dateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: tz,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).formatToParts(new Date());
const datePart = (k) => dateParts.find((x) => x.type === k).value;
const today = datePart('year') + '-' + datePart('month') + '-' + datePart('day');
$('#date').value = today;
let fixtures = [],
  odds = new Map(),
  coupon = [],
  // Dernière copie du ticket du jour dans le coupon : sert seulement à choisir la note du
  // coupon (copie intacte ou coupon manuel). Aucune probabilité n'est calculée ici.
  ticketCopy = null,
  history = [],
  pageNum = 0,
  totalPages = 0,
  loading = false,
  generation = 0,
  matchPage = 1,
  llmConfigured = false,
  activeView = 'today';
const MATCH_PAGE_SIZE = 12;
try {
  history = JSON.parse(localStorage.getItem('footscope-history') || '[]');
  if (!Array.isArray(history)) history = [];
} catch {}
function toast(t) {
  $('#toast').textContent = t;
  $('#toast').classList.remove('hidden');
  setTimeout(() => $('#toast').classList.add('hidden'), 4500);
}
function time(s) {
  return s
    ? new Date(s).toLocaleTimeString('fr-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
    : '—';
}
function stamp(s) {
  return s ? new Date(s).toLocaleString('fr-CA', { timeZone: tz }) : 'Non renseignée';
}
// Format du design system : « Sam. 17 oct. · 10h00 », à l’heure d’Ottawa.
function kickoff(s) {
  if (!s) return '—';
  const day = new Date(s).toLocaleDateString('fr-FR', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return day.charAt(0).toUpperCase() + day.slice(1) + ' · ' + time(s).replace(/\s?h\s?/, 'h');
}
// Écusson neutre : aucun logo de club, seulement les initiales. Les préfixes génériques
// (« FC », « AS »…), les particules en minuscules (« de ») et les nombres sont ignorés :
// « Olympique de Marseille » donne « OM », « 1. FC Köln » donne « KÖ ».
const GENERIC_CLUB_WORDS = new Set(
  'AC AFC AS BK CA CD CF CS FC FK IF NK RC SC SD SK SS SSC SV UD US'.split(' '),
);
function initials(name) {
  const words = String(name ?? '')
    .split(/[\s\-–—.']+/)
    .filter(Boolean);
  const named = words.filter(
    (w) => !GENERIC_CLUB_WORDS.has(w.toUpperCase()) && !/^(\d+|\p{Ll}.*)$/u.test(w),
  );
  const pick = named.length ? named : words;
  const letters =
    pick.length > 1 ? [pick[0][0], pick[1][0]] : Array.from(pick[0] || '?').slice(0, 2);
  return letters.join('').toUpperCase();
}
function crest(name, size = '') {
  return '<span class="crest ' + size + '" aria-hidden="true">' + esc(initials(name)) + '</span>';
}
// Nom d'équipe : coupé sur deux lignes au plus, puis abrégé ; le nom complet reste en title.
function teamName(name) {
  return '<span class="teamname" title="' + esc(name) + '">' + esc(name) + '</span>';
}
function moveFocus(el) {
  if (el?.focus) el.focus();
}
function fresh(s) {
  const age = Date.now() - Date.parse(s);
  return Number.isFinite(age) && age >= -300000 && age <= 24 * 60 * 60000;
}
async function get(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  const raw = await r.text();
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    throw Error(
      r.status === 401 || r.status === 403 || r.redirected
        ? 'La session du site a expiré. Ouvrez le site dans un nouvel onglet et reconnectez-vous.'
        : 'Réponse serveur inattendue (HTTP ' + r.status + '). Réessayez.',
    );
  }
  if (!r.ok) {
    const e = Error(d.error || 'Erreur de connexion');
    e.code = d.code || null;
    e.retryable = r.status === 429 && d.retryable === true;
    e.retryAfter = Number(d.retryAfter) || 65;
    throw e;
  }
  return d;
}
// Nouvel essai automatique après une pause du fournisseur, avec compte à rebours visible.
// Annulé si l'utilisateur change de date, de filtre ou de vue entre-temps.
let retryTimer = null,
  retryState = null;
const MAX_AUTO_RETRIES = 2;
function cancelRetry() {
  clearInterval(retryTimer);
  retryTimer = null;
  if (retryState) retryState.target.textContent = retryState.label;
  retryState = null;
}
function advanceGeneration() {
  cancelRetry();
  generation++;
  loading = false;
  $('#refresh').disabled = false;
  return generation;
}
function scheduleRetry(seconds, gen, target, label, attempt, action) {
  cancelRetry();
  if (attempt >= MAX_AUTO_RETRIES) {
    target.textContent = label + ' Reprises automatiques arrêtées. Actualisez pour réessayer.';
    return;
  }
  const delay = Number(seconds);
  const until = Date.now() + (Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : 65) * 1000;
  retryState = { target, label };
  const tick = () => {
    if (gen !== generation || activeView !== 'today') return cancelRetry();
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      cancelRetry();
      action(attempt + 1);
      return;
    }
    target.textContent = label + ' Nouvel essai automatique dans ' + left + ' s.';
  };
  retryTimer = setInterval(tick, 1000);
  tick();
}
async function init() {
  try {
    const d = await get('/api/status');
    const active = !!d.subscription?.active;
    // subscription décrit l'abonnement au fournisseur API-Football, pas une offre Footscope :
    // il est affiché à côté du quota qu'il fixe, jamais comme un statut de l'utilisateur.
    $('#connection').textContent = active ? 'API-Football connecté' : 'API-Football inactif';
    $('#connectionPill').classList.toggle('off', !active);
    $('#quota').textContent = (d.requests?.limit_day || '—').toLocaleString('fr-CA');
    $('#providerPlan').textContent =
      'API-Football · plan ' +
      (d.subscription?.plan || 'inconnu') +
      ' · ' +
      (active ? 'actif' : 'inactif');
    $('#providerPlan').classList.remove('hidden');
  } catch (e) {
    $('#connection').textContent = 'Connexion à vérifier';
    $('#connectionPill').classList.add('off');
  }
  await load();
}
async function load(attempt = 0) {
  const gen = advanceGeneration();
  current = null;
  loading = true;
  $('#refresh').disabled = true;
  $('#matches').innerHTML = '<div class="loader">Lecture du programme et des cotes…</div>';
  $('#details').classList.add('hidden');
  $('#program').classList.remove('hidden');
  fixtures = [];
  odds.clear();
  pageNum = 0;
  totalPages = 0;
  $('#more').classList.add('hidden');
  const date = $('#date').value;
  try {
    const results = await Promise.allSettled([
      get('/api/fixtures?date=' + date),
      get('/api/odds?date=' + date + '&page=1'),
    ]);
    if (gen !== generation) return;
    let notices = [];
    if (results[0].status === 'fulfilled') {
      fixtures = results[0].value.response;
      notices.push('Programme consulté : ' + stamp(results[0].value.retrievedAt));
    } else notices.push(results[0].reason.message);
    if (results[1].status === 'fulfilled') {
      ingest(results[1].value);
      pageNum = 1;
      totalPages = results[1].value.paging.total;
    } else notices.push('Cotes indisponibles : ' + results[1].reason.message);
    $('#status').textContent = notices.join(' · ');
    const paused = results.find((x) => x.status === 'rejected' && x.reason.retryable);
    if (paused)
      scheduleRetry(
        paused.reason.retryAfter,
        gen,
        $('#status'),
        notices.join(' · '),
        attempt,
        load,
      );
    const countries = [...new Set(fixtures.map((f) => f.league.country).filter(Boolean))].sort();
    const selected = $('#country').value;
    $('#country').innerHTML =
      '<option value="">Tous les pays</option>' +
      countries.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
    if (countries.includes(selected)) $('#country').value = selected;
    updateLeagues();
    matchPage = 1;
    render();
  } finally {
    if (gen === generation) {
      loading = false;
      $('#refresh').disabled = false;
    }
  }
}
function ingest(d) {
  for (const x of d.response)
    if (fixtures.some((f) => f.fixture.id === x.fixture.id)) odds.set(x.fixture.id, x);
}
function filteredFixtures() {
  const search = $('#search').value.toLowerCase(),
    league = $('#league').value,
    country = $('#country').value;
  return fixtures
    .filter(
      (f) =>
        (!country || f.league.country === country) &&
        (!league || f.league.name === league) &&
        (!$('#onlyOdds').checked || odds.has(f.fixture.id)) &&
        (f.teams.home.name + ' ' + f.teams.away.name).toLowerCase().includes(search),
    )
    .sort(
      (a, b) =>
        Number(odds.has(b.fixture.id)) - Number(odds.has(a.fixture.id)) ||
        a.fixture.timestamp - b.fixture.timestamp,
    );
}
function render() {
  const rows = filteredFixtures();
  const pages = Math.max(1, Math.ceil(rows.length / MATCH_PAGE_SIZE));
  matchPage = Math.min(Math.max(matchPage, 1), pages);
  const visible = rows.slice((matchPage - 1) * MATCH_PAGE_SIZE, matchPage * MATCH_PAGE_SIZE);
  $('#prevMatches').disabled = matchPage === 1;
  $('#nextMatches').disabled = matchPage === pages;
  $('#matchPage').textContent = 'PAGE ' + matchPage + ' / ' + pages;
  $('#count').textContent = fixtures.length;
  $('#oddsCount').textContent = odds.size;
  $('#visibleCount').textContent = rows.length + (rows.length > 1 ? ' matchs' : ' match');
  $('#matches').innerHTML = rows.length
    ? visible
        .map((f) => {
          const o = odds.get(f.fixture.id);
          const label = esc(f.teams.home.name) + ' contre ' + esc(f.teams.away.name);
          return (
            '<article class="match"><div class="matchmeta"><span class="league">' +
            esc(f.league.name) +
            ' · ' +
            esc(f.league.country) +
            '</span><time datetime="' +
            esc(f.fixture.date) +
            '">' +
            kickoff(f.fixture.date) +
            (f.fixture.status.short === 'NS' ? '' : ' · ' + esc(f.fixture.status.short)) +
            '</time></div><div class="teams"><div class="team">' +
            crest(f.teams.home.name) +
            teamName(f.teams.home.name) +
            '</div><span class="visually-hidden">contre</span><div class="team">' +
            crest(f.teams.away.name) +
            teamName(f.teams.away.name) +
            '</div></div><div class="matchfoot"><span class="tag ' +
            (o ? (fresh(o.update) ? 'ok' : '') : 'muted') +
            '">' +
            (o ? (fresh(o.update) ? 'Cotes récentes' : 'Cotes anciennes') : 'Cotes non chargées') +
            '</span><button class="btn secondary sm" data-match="' +
            f.fixture.id +
            '" aria-label="Voir l’analyse : ' +
            label +
            '">Voir l’analyse <span aria-hidden="true">›</span></button></div></article>'
          );
        })
        .join('')
    : fixtures.length
      ? '<div class="empty"><b>Aucun match ne correspond aux filtres.</b>Les cotes sont chargées progressivement : leur absence ici ne prouve pas leur absence chez le fournisseur.</div>'
      : '<div class="empty"><b>Aucun match chargé pour cette date.</b>Si un message s’affiche au-dessus, le programme n’a pas pu être lu chez le fournisseur : ce vide ne signifie pas qu’aucun match n’est prévu.</div>';
  $('#more').classList.toggle('hidden', pageNum >= totalPages);
  $('#more').textContent = 'Charger davantage de cotes (' + pageNum + ' / ' + totalPages + ')';
}
$('#more').onclick = async () => {
  const gen = generation;
  $('#more').disabled = true;
  try {
    const d = await get('/api/odds?date=' + $('#date').value + '&page=' + (pageNum + 1));
    if (gen !== generation) return;
    pageNum++;
    ingest(d);
    render();
  } catch (e) {
    toast(e.message);
  } finally {
    $('#more').disabled = false;
  }
};
function updateLeagues() {
  const selected = $('#league').value;
  const leagues = [
    ...new Set(
      fixtures
        .filter((f) => !$('#country').value || f.league.country === $('#country').value)
        .map((f) => f.league.name),
    ),
  ].sort();
  $('#league').innerHTML =
    '<option value="">Tous les championnats</option>' +
    leagues.map((l) => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('');
  if (leagues.includes(selected)) $('#league').value = selected;
}
function filterChanged() {
  advanceGeneration();
  matchPage = 1;
  $('#details').classList.add('hidden');
  $('#program').classList.remove('hidden');
  $('#assistantResult').classList.add('hidden');
  marketCouponsState('idle');
  render();
}
$('#refresh').onclick = () => load();
function renderDateStrip() {
  const strip = $('#dateStrip');
  if (!strip) return;
  const selected = $('#date').value;
  const anchor = new Date(selected + 'T12:00:00Z');
  if (!Number.isFinite(anchor.getTime())) return;
  strip.innerHTML = Array.from({ length: 5 }, (_, index) => {
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() + index - 2);
    const value = date.toISOString().slice(0, 10);
    const label = date.toLocaleDateString('fr-CA', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    return (
      '<button type="button" data-date="' +
      value +
      '"' +
      (value === selected ? ' aria-current="date"' : '') +
      '>' +
      esc(label) +
      '</button>'
    );
  }).join('');
  strip.onclick = (event) => {
    const button = event.target.closest('[data-date]');
    if (!button || typeof window === 'undefined' || !window.matchMedia) return;
    $('#date').value = button.dataset.date;
    renderDateStrip();
    load();
    // Conserver le focus sur la date choisie après reconstruction du bandeau.
    strip.querySelector('[aria-current="date"]').focus();
  };
}
renderDateStrip();
$('#date').onchange = () => {
  renderDateStrip();
  load();
};
$('#search').oninput = filterChanged;
$('#country').onchange = () => {
  updateLeagues();
  filterChanged();
};
$('#league').onchange = filterChanged;
$('#onlyOdds').onchange = filterChanged;
$('#prevMatches').onclick = () => {
  matchPage--;
  render();
  $('#program').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('#nextMatches').onclick = () => {
  matchPage++;
  render();
  $('#program').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
let current = null,
  marketChoices = [];
function recent(list, id) {
  return list
    .filter(
      (f) =>
        f.fixture.status.short === 'FT' &&
        Number.isFinite(f.goals.home) &&
        Number.isFinite(f.goals.away),
    )
    .map((f) => {
      const home = f.teams.home.id === id;
      const gf = home ? f.goals.home : f.goals.away,
        ga = home ? f.goals.away : f.goals.home;
      return {
        gf,
        ga,
        result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
        opponent: home ? f.teams.away.name : f.teams.home.name,
        date: f.fixture.date,
      };
    });
}
const RESULT_LABELS = {
  W: ['V', 'Victoire'],
  D: ['N', 'Nul'],
  L: ['D', 'Défaite'],
};
function formHTML(a) {
  return a.length
    ? '<div class="formstrip" aria-hidden="true">' +
        a.map((f) => '<span class="' + f.result + '"></span>').join('') +
        '</div>' +
        a
          .map(
            (f) =>
              '<div class="formrow"><i class="' +
              f.result +
              '" aria-hidden="true">' +
              RESULT_LABELS[f.result][0] +
              '</i><span class="visually-hidden">' +
              RESULT_LABELS[f.result][1] +
              ' contre</span><span>' +
              esc(f.opponent) +
              '</span><b class="score">' +
              f.gf +
              '–' +
              f.ga +
              '</b></div>',
          )
          .join('')
    : '<p class="note">Historique indisponible</p>';
}
function poisson(l) {
  let a = [Math.exp(-l)];
  for (let k = 1; k < 25; k++) a[k] = (a[k - 1] * l) / k;
  return a;
}
function model(a, b) {
  if (a.length < 8 || b.length < 8) return null;
  const mean = (v, k) => v.reduce((s, x) => s + x[k], 0) / v.length;
  const lh = (mean(a, 'gf') + mean(b, 'ga')) / 2,
    la = (mean(b, 'gf') + mean(a, 'ga')) / 2;
  const h = poisson(lh),
    v = poisson(la);
  let over = 0,
    btts = 0;
  for (let i = 0; i < h.length; i++)
    for (let j = 0; j < v.length; j++) {
      const p = h[i] * v[j];
      if (i + j > 2) over += p;
      if (i && j) btts += p;
    }
  return { lh, la, over, btts };
}
$('#matches').onclick = (e) => {
  const b = e.target.closest('[data-match]');
  if (b) detail(b.dataset.match);
};
// Export global du script classique, utilisable sans DOM ni effet de bord.
// 'bet365' correspond à PREFERRED_BOOKMAKER dans src/server/coupon.js, normalisé en minuscules.
function preferredBookIndex(books) {
  const index = books.findIndex(
    (book) =>
      String(book?.name ?? '')
        .trim()
        .toLowerCase() === 'bet365',
  );
  return index < 0 ? 0 : index;
}
const manualBookChoices = new Map();
async function detail(id, attempt = 0) {
  const gen = advanceGeneration();
  current = null;
  $('#program').classList.add('hidden');
  $('#details').classList.remove('hidden');
  $('#details').innerHTML =
    '<div class="loader">Lecture de la forme, des absences et des marchés…</div>';
  try {
    const d = await get('/api/match?id=' + id);
    if (gen !== generation) return;
    current = d;
    const f = d.fixture;
    const a = recent(d.home, f.teams.home.id),
      b = recent(d.away, f.teams.away.id),
      m = model(a, b);
    const bookCount = (d.odds[0]?.bookmakers || []).length;
    $('#details').innerHTML =
      '<button class="btn secondary" id="back">← Retour aux rencontres</button><div class="detailhead"><p class="eyebrow">' +
      esc(f.league.name) +
      ' · ' +
      kickoff(f.fixture.date) +
      '</p><h2 id="detailTitle" tabindex="-1"><span class="team">' +
      crest(f.teams.home.name, 'lg') +
      teamName(f.teams.home.name) +
      '</span><span class="vs">contre</span><span class="team away">' +
      crest(f.teams.away.name, 'lg') +
      teamName(f.teams.away.name) +
      '</span></h2><div class="datastatus"><span class="tag ' +
      (a.length && b.length ? 'ok' : '') +
      '">Forme récente · ' +
      a.length +
      ' et ' +
      b.length +
      ' matchs</span><span class="tag ' +
      (d.injuries.length ? 'ok' : '') +
      '">' +
      d.injuries.length +
      ' absence(s) signalée(s)</span>' +
      (d.lineups.length ? '<span class="tag ok">Compositions publiées</span>' : '') +
      '<span class="tag ' +
      (bookCount ? 'ok' : '') +
      '">' +
      bookCount +
      ' bookmaker(s)</span></div></div><p class="notice">' +
      (Object.keys(d.errors).length ? 'Certaines sources sont indisponibles. ' : '') +
      'Données consultées : ' +
      stamp(d.retrievedAt) +
      '. Compositions ' +
      (d.lineups.length ? 'disponibles' : 'non disponibles') +
      '. ' +
      d.injuries.length +
      ' absence(s) signalée(s) — une liste vide ne confirme pas un effectif complet.</p><div class="grid"><div class="card"><h3>' +
      esc(f.teams.home.name) +
      '</h3><p class="note">' +
      a.length +
      ' matchs terminés récents</p>' +
      formHTML(a) +
      '</div><div class="card"><h3>' +
      esc(f.teams.away.name) +
      '</h3><p class="note">' +
      b.length +
      ' matchs terminés récents</p>' +
      formHTML(b) +
      '</div></div><div class="card"><p class="eyebrow">Modèle exploratoire · non validé</p>' +
      (m
        ? '<div class="grid"><div><p>Plus de 2,5 buts</p><strong class="stat">' +
          Math.round(m.over * 100) +
          ' %</strong><div class="bar"><span style="width:' +
          m.over * 100 +
          '%"></span></div></div><div><p>Les deux équipes marquent</p><strong class="stat">' +
          Math.round(m.btts * 100) +
          ' %</strong><div class="bar"><span style="width:' +
          m.btts * 100 +
          '%"></span></div></div></div><p class="note">Poisson indépendant · Moyennes des ' +
          a.length +
          ' et ' +
          b.length +
          ' matchs terminés. Aucune correction de force des adversaires, domicile, blessures ou composition. Ces chiffres ne déclenchent aucune recommandation.</p>'
        : '<p class="note">Historique insuffisant : au moins huit matchs terminés par équipe sont nécessaires pour cette exploration.</p>') +
      '</div><div class="card"><h3>' +
      (d.lineups.length ? 'Absences et compositions' : 'Absences') +
      '</h3><p class="note">' +
      (d.injuries.length
        ? d.injuries.map((x) => esc(x.player?.name) + ' — ' + esc(x.player?.reason)).join('<br>')
        : 'Aucune absence retournée. À confirmer avec les communications officielles.') +
      '</p>' +
      d.lineups
        .map(
          (x) =>
            '<p class="note"><b>' +
            esc(x.team?.name) +
            '</b> · ' +
            esc(x.formation) +
            '<br>' +
            x.startXI.map((p) => esc(p.player?.name)).join(', ') +
            '</p>',
        )
        .join('') +
      '</div><div class="card"><h3>Les marchés et leur prix</h3><p class="note">Seuil = 1 ÷ cote. Ce tableau ne calcule pas de valeur attendue pour les marchés non modélisés. L’ajout au coupon est une simulation choisie manuellement. Les règles de règlement du bookmaker restent à vérifier.</p><div class="bookrow"><label for="book">Bookmaker</label><select id="book" aria-label="Bookmaker"></select></div><div id="marketTable" class="scroll"></div></div>';
    $('#back').onclick = () => {
      advanceGeneration();
      current = null;
      $('#details').classList.add('hidden');
      $('#program').classList.remove('hidden');
      moveFocus($('#programTitle'));
    };
    moveFocus($('#detailTitle'));
    const books = d.odds[0]?.bookmakers || [];
    $('#book').innerHTML = books.length
      ? books.map((x, i) => '<option value="' + i + '">' + esc(x.name) + '</option>').join('')
      : '<option>Aucune cote disponible</option>';
    const manualBook = manualBookChoices.get(String(id));
    const manualIndex = books.findIndex(
      (book) =>
        String(book?.name ?? '')
          .trim()
          .toLowerCase() === manualBook,
    );
    $('#book').value = String(manualIndex < 0 ? preferredBookIndex(books) : manualIndex);
    $('#book').onchange = () => {
      const book = books[Number($('#book').value)];
      if (book)
        manualBookChoices.set(
          String(id),
          String(book?.name ?? '')
            .trim()
            .toLowerCase(),
        );
      renderMarkets();
    };
    renderMarkets();
  } catch (e) {
    if (gen !== generation) return;
    $('#details').innerHTML =
      '<button class="btn secondary" id="back">← Retour aux rencontres</button><div class="empty detailerror" id="detailTitle" tabindex="-1"><b>Fiche indisponible.</b><p id="detailError">' +
      esc(e.message) +
      '</p></div>';
    $('#back').onclick = () => {
      advanceGeneration();
      current = null;
      $('#details').classList.add('hidden');
      $('#program').classList.remove('hidden');
      moveFocus($('#programTitle'));
    };
    moveFocus($('#detailTitle'));
    if (e.retryable)
      scheduleRetry(e.retryAfter, gen, $('#detailError'), e.message, attempt, (next) =>
        detail(id, next),
      );
  }
}
function renderMarkets() {
  const record = current.odds[0];
  const book = record?.bookmakers[Number($('#book').value) || 0];
  marketChoices = [];
  if (!book) {
    $('#marketTable').innerHTML = '<div class="empty">Aucune cote retournée pour ce match.</div>';
    return;
  }
  const updated = record.update,
    available =
      fresh(updated) &&
      current.fixture.fixture.timestamp * 1000 > Date.now() &&
      current.fixture.fixture.status.short === 'NS';
  for (const market of book.bets) {
    for (const value of market.values) {
      if (Number(value.odd) > 1)
        marketChoices.push({
          matchId: current.fixture.fixture.id,
          match: current.fixture.teams.home.name + ' — ' + current.fixture.teams.away.name,
          market: market.name,
          selection: value.value,
          odd: Number(value.odd),
          bookmaker: book.name,
          updated,
          kickoff: current.fixture.fixture.date,
        });
    }
  }
  $('#marketTable').innerHTML =
    '<p class="note">Mise à jour du fournisseur : ' +
    stamp(updated) +
    oddsAgeHTML(updated) +
    (available ? '' : ' · Ajout bloqué : cote ancienne, horaire passé ou match déjà commencé.') +
    '</p><table><thead><tr><th scope="col">Marché / sélection</th><th scope="col">Cote</th><th scope="col">Seuil</th><th scope="col"><span class="visually-hidden">Ajouter au coupon</span></th></tr></thead><tbody>' +
    marketChoices
      .map(
        (x, i) =>
          '<tr><td>' +
          esc(x.market) +
          '<br><b>' +
          esc(x.selection) +
          '</b></td><td class="num">' +
          x.odd.toFixed(2) +
          '</td><td class="num">' +
          (100 / x.odd).toFixed(1) +
          ' %</td><td><button class="btn secondary sm" data-add="' +
          i +
          '" aria-label="Ajouter au coupon : ' +
          esc(x.market) +
          ', ' +
          esc(x.selection) +
          '" ' +
          (!available ? 'disabled' : '') +
          '>+</button></td></tr>',
      )
      .join('') +
    '</tbody></table>';
  $('#marketTable').onclick = (e) => {
    const btn = e.target.closest('[data-add]');
    if (btn) add(marketChoices[Number(btn.dataset.add)]);
  };
}
function add(x) {
  if (coupon.length >= 4) return toast('Quatre sélections maximum.');
  if (coupon.some((y) => y.matchId === x.matchId))
    return toast('Une seule sélection par match : dépendances non modélisées.');
  if (!fresh(x.updated) || Date.parse(x.kickoff) <= Date.now())
    return toast('Cette sélection doit être actualisée.');
  coupon.push(x);
  renderCoupon();
  toast('Ajoutée au coupon de simulation.');
}
function renderCoupon() {
  $('#couponReview').textContent = '';
  const total = coupon.reduce((p, x) => p * x.odd, 1);
  $('#slots').textContent = coupon.length + ' / 4';
  $('#couponItems').innerHTML = coupon.length
    ? coupon
        .map(
          (x, i) =>
            '<div class="couponitem"><div><b class="matchname" title="' +
            esc(x.match) +
            '">' +
            esc(x.match) +
            '</b>' +
            esc(x.market) +
            ' · ' +
            esc(x.selection) +
            '<br><span class="note">' +
            esc(x.bookmaker) +
            ' · ' +
            esc(oddsAge(x.updated)) +
            '</span>' +
            oddsWarningHTML(x) +
            '</div><strong class="odd">' +
            x.odd.toFixed(2) +
            '</strong><button class="iconbtn" data-remove="' +
            i +
            '" aria-label="Retirer la sélection : ' +
            esc(x.match) +
            '">×</button></div>',
        )
        .join('')
    : '<div class="empty">Aucune sélection.<br>Ouvrez une fiche de match pour examiner les cotes.</div>';
  $('#combined').textContent = coupon.length ? total.toFixed(2) : '—';
  const intactCopy =
    ticketCopy &&
    coupon.length === ticketCopy.items.length &&
    coupon.every((x, i) => x === ticketCopy.items[i]);
  $('#couponProbability').textContent = !intactCopy
    ? 'Coupon manuel : Footscope ne calcule pas sa probabilité, car la dépendance entre les matchs et la calibration restent à valider. Les cotes peuvent changer.'
    : ticketCopy.probability !== null
      ? 'Copie intacte du ticket du jour. Probabilité estimée par le serveur pour ces sélections au moment de l’analyse : ' +
        (ticketCopy.probability * 100).toFixed(1) +
        ' %, exploratoire et non calibrée. Si vous modifiez ce coupon, il devient manuel et aucune probabilité n’est calculée.'
      : 'Copie intacte du ticket du jour : le serveur n’a pas fourni de probabilité pour ce ticket, et Footscope n’en calcule pas ici. Les cotes peuvent changer.';
  const stake = Number($('#stake').value);
  $('#return').textContent =
    coupon.length && Number.isFinite(stake) && stake >= 0
      ? (stake * total).toFixed(2) + ' CAD'
      : '—';
}
$('#couponItems').onclick = (e) => {
  const b = e.target.closest('[data-remove]');
  if (b) {
    coupon.splice(Number(b.dataset.remove), 1);
    renderCoupon();
  }
};
$('#stake').oninput = renderCoupon;
$('#save').onclick = () => {
  if (!coupon.length) return toast('Ajoutez une sélection pour enregistrer.');
  const stake = Number($('#stake').value);
  if (!Number.isFinite(stake) || stake < 0 || stake > 100000)
    return toast('Mise fictive invalide.');
  if (coupon.some((x) => !fresh(x.updated) || Date.parse(x.kickoff) <= Date.now()))
    return toast('Une cote est ancienne ou un match a commencé. Rechargez les marchés.');
  const bet = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    selections: [...coupon],
    stake,
    odd: coupon.reduce((p, x) => p * x.odd, 1),
    result: 'pending',
  };
  history.unshift(bet);
  try {
    localStorage.setItem('footscope-history', JSON.stringify(history));
  } catch {
    return toast('Stockage local indisponible.');
  }
  coupon = [];
  renderCoupon();
  renderJournal();
  toast('Simulation enregistrée dans ce navigateur.');
};
function renderJournal() {
  $('#journalList').innerHTML = history.length
    ? history
        .map(
          (x) =>
            '<div class="journalitem"><div><b>' +
            stamp(x.createdAt) +
            '</b><p>' +
            x.selections.map((s) => esc(s.match) + ' · ' + esc(s.selection)).join('<br>') +
            '</p><p>Mise fictive ' +
            x.stake +
            ' CAD · Cote ' +
            x.odd.toFixed(2) +
            '</p><p class="note">' +
            (x.result === 'won'
              ? 'Bénéfice simulé : ' + (x.stake * (x.odd - 1)).toFixed(2) + ' CAD'
              : x.result === 'lost'
                ? 'Perte simulée : ' + x.stake + ' CAD'
                : x.result === 'void'
                  ? 'Mise fictive restituée'
                  : 'Résultat non renseigné') +
            '</p></div><select data-result="' +
            x.id +
            '" aria-label="Résultat manuel"><option value="pending" ' +
            (x.result === 'pending' ? 'selected' : '') +
            '>En attente</option><option value="won" ' +
            (x.result === 'won' ? 'selected' : '') +
            '>Gagné</option><option value="lost" ' +
            (x.result === 'lost' ? 'selected' : '') +
            '>Perdu</option><option value="void" ' +
            (x.result === 'void' ? 'selected' : '') +
            '>Entièrement annulé</option></select></div>',
        )
        .join('')
    : '<div class="empty">Aucune simulation enregistrée.</div>';
}
$('#journalList').onchange = (e) => {
  if (!e.target.dataset.result) return;
  const row = history.find((x) => x.id === Number(e.target.dataset.result));
  if (row && ['pending', 'won', 'lost', 'void'].includes(e.target.value)) {
    row.result = e.target.value;
    try {
      localStorage.setItem('footscope-history', JSON.stringify(history));
      renderJournal();
    } catch {
      toast('Stockage local indisponible.');
    }
  }
};
$('#export').onclick = () => {
  const u = URL.createObjectURL(
    new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = u;
  a.download = 'footscope-suivi.json';
  a.click();
  URL.revokeObjectURL(u);
};
function calc() {
  const o = Number($('#calcOdds').value),
    p = Number($('#calcP').value);
  $('#calcResult').textContent =
    o > 1 && p >= 0 && p <= 100
      ? 'Seuil : ' +
        (100 / o).toFixed(1) +
        ' % · Espérance hypothétique : ' +
        (((p / 100) * o - 1) * 100).toFixed(1) +
        ' % par unité misée.'
      : 'Saisissez une cote supérieure à 1 et une probabilité de 0 à 100 %.';
}
$('#calcOdds').oninput = calc;
$('#calcP').oninput = calc;
document.querySelectorAll('nav button').forEach(
  (b) =>
    (b.onclick = () => {
      advanceGeneration();
      activeView = b.dataset.view;
      document.querySelectorAll('nav button').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.ariaCurrent = x === b ? 'page' : null;
      });
      ['today', 'journal', 'method'].forEach((id) =>
        $('#' + id).classList.toggle('hidden', id !== b.dataset.view),
      );
    }),
);
$('#seeMethod').onclick = () => {
  $('nav button[data-view="method"]').click();
  moveFocus($('#methodTitle'));
};

async function assistantInit() {
  try {
    const d = await get('/api/assistant/status');
    llmConfigured = d.configured;
    $('#assistantState').textContent = llmConfigured
      ? 'Moteur statistique · LLM configuré, disponibilité vérifiée à chaque analyse.'
      : 'Moteur statistique disponible · explications LLM indisponibles.';
  } catch {
    $('#assistantState').textContent = 'Connexion assistant indisponible.';
  }
}
async function waitForProvider(seconds, gen) {
  for (let left = seconds; left > 0; left--) {
    if (generation !== gen) throw Error('Filtres modifiés : analyse interrompue.');
    if (assistantBusy) {
      $('#assistantResult').classList.remove('hidden');
      $('#assistantResult').textContent =
        'API-Football en pause · reprise automatique dans ' +
        left +
        ' s. Les pages déjà chargées sont conservées.';
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
async function post(path, body) {
  const gen = generation;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let d;
    try {
      d = await r.json();
    } catch {
      throw Error('Réponse serveur inattendue. Rechargez le site.');
    }
    if (r.ok) return d;
    if (r.status === 429 && d.retryable && attempt < 2) {
      await waitForProvider(Math.max(1, Math.min(300, Number(d.retryAfter) || 65)), gen);
      continue;
    }
    const e = Error(d.error || 'Analyse indisponible');
    e.code = d.code;
    throw e;
  }
}
function verdictLabel(v) {
  return (
    {
      api_paused: 'API-FOOTBALL EN PAUSE',
      simulation_eligible: 'ADMISSIBLE EN SIMULATION',
      review_required: 'À CONFIRMER',
      reject: 'REFUSÉ',
      insufficient: 'DONNÉES INSUFFISANTES',
    }[v] || 'NON ÉVALUABLE'
  );
}
// BIS-200 : valeur face au marché fournie par le serveur (d.market), jamais recalculée ici.
// Descriptive : elle ne dit pas qu'une sélection est gagnante et ne change pas le ticket.
// Association par rôle et position (index fourni par le serveur) : elle tient même quand
// la sélection est absente du fournisseur et que le serveur n'a repris aucune de ses données.
function valueCheck(market, role, index, x) {
  return (market?.checks || []).find(
    (c) =>
      c.role === role &&
      c.index === index &&
      (c.matchId === null || c.matchId === undefined || c.matchId === x?.matchId),
  );
}
// Un écart non nul trop petit pour une décimale reste signé (« −<0,1 % ») : il ne se
// confond pas avec l'égalité, affichée « À la cote juste ».
const signedPercent = (v) =>
  (v > 0 ? '+' : v < 0 ? '−' : '') +
  (v !== 0 && Math.abs(v) < 0.0005
    ? '&lt;0,1'
    : Math.abs(v * 100).toLocaleString('fr-FR', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })) +
  '\u00a0%';
function valueBadge(check) {
  if (!check) return '';
  // Sélection absente du fournisseur : sa raison figure déjà dans les raisons générales
  // de la sélection ; le badge ne la répète pas.
  if (!Number.isFinite(check.marketValue))
    return (
      '<span class="valuebadge"><span class="tag muted">Valeur face au marché : —</span>' +
      (check.reasonCode === 'EVENT_MISSING'
        ? ''
        : '<small>' + esc(check.reason || 'Pas de repère Pinnacle.') + '</small>') +
      '</span>'
    );
  const fair =
    'cote juste Pinnacle\u00a0' +
    check.fairOdd.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (check.atFairOdd)
    return (
      '<span class="valuebadge"><span class="tag muted">À la cote juste</span><small>bet365 égal à la ' +
      fair +
      '</small></span>'
    );
  return check.hasValue
    ? '<span class="valuebadge"><span class="tag ok">Valeur face au marché\u00a0' +
        signedPercent(check.marketValue) +
        '</span><small>bet365 au-dessus de la ' +
        fair +
        '</small></span>'
    : '<span class="valuebadge"><span class="tag muted">Sous la cote juste\u00a0' +
        signedPercent(check.marketValue) +
        '</span><small>bet365 au plus à la ' +
        fair +
        '</small></span>';
}
// Ticket entier : « oui » seulement si chaque sélection a une valeur calculée positive.
function valueFact(market) {
  if (
    !market ||
    market.allSelectionsHaveValue === null ||
    market.allSelectionsHaveValue === undefined
  )
    return '';
  return (
    '<div class="valuefact"><dt>Valeur face au marché</dt><dd>Toutes les sélections : ' +
    (market.allSelectionsHaveValue ? 'oui' : 'non') +
    '<small>bet365 contre cote juste Pinnacle · repère descriptif, pas une promesse de gain</small></dd></div>'
  );
}
// Âge fournisseur au moment du rendu ; aucune heure inventée si absente ou future.
function oddsAge(updated, now = Date.now()) {
  const age = typeof updated === 'string' ? now - Date.parse(updated) : NaN;
  if (!Number.isFinite(age)) return 'Âge de la cote indisponible';
  if (age < 0) return 'Horodatage de la cote dans le futur';
  const minutes = Math.floor(age / 60000);
  return (
    'cote mise à jour il y a ' +
    (minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min')
  );
}
function oddsAgeHTML(updated) {
  return '<span class="oddsage">' + esc(oddsAge(updated)) + '</span>';
}
// Le minimum affiché est arrondi vers le haut : un prix inférieur ne suffit pas.
function oddsWarningHTML(x) {
  const age = oddsAge(x.updated);
  const label = age.startsWith('cote mise à jour il y a ')
    ? age.replace('cote mise à jour', 'Cote relevée') + '.'
    : age + '.';
  const minimum =
    Number.isFinite(x.minOdds) && x.minOdds > 1
      ? (Math.ceil(x.minOdds * 100) / 100).toFixed(2)
      : null;
  return (
    '<p class="note oddsnotice">' +
    esc(label) +
    ' Vérifie la cote actuelle chez le bookmaker : ne joue que si elle est au moins égale à la cote minimum affichée.' +
    '<br>Cote minimum : <strong>' +
    (minimum || 'indisponible') +
    '</strong>' +
    (minimum ? '' : ' · Ne joue pas sans cote minimum vérifiée.') +
    '</p>'
  );
}
// BIS-220 : « Coupons du jour » selon le marché. Le serveur fournit `marketCoupons` ; rien n'est
// recalculé ici et toute donnée qui n'a pas la forme attendue est écartée, jamais complétée.
const COUPON_SIZES = { 1: 'Simple', 2: 'Double', 3: 'Triple' };
const COUPON_WARNING =
  'Confiance = probabilité du marché sans marge, non garantie. Vérifie la cote actuelle chez le bookmaker.';
const isRatio = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v > 1;
const frPercent = (v) =>
  (v * 100).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
const frOdd = (v) =>
  v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function validMarketSelection(x) {
  return (
    x &&
    typeof x === 'object' &&
    (typeof x.matchId === 'string' ||
      (typeof x.matchId === 'number' && Number.isFinite(x.matchId))) &&
    ['match', 'market', 'selection'].every((k) => typeof x[k] === 'string' && x[k]) &&
    typeof x.kickoff === 'string' &&
    Number.isFinite(Date.parse(x.kickoff)) &&
    isRatio(x.marketProbability) &&
    isPrice(x.odd) &&
    (x.modelCheck === 'ok' || x.modelCheck === 'non vérifié')
  );
}
function validMarketCoupon(c) {
  return (
    c &&
    typeof c === 'object' &&
    c.size in COUPON_SIZES &&
    c.bookmaker === 'bet365' &&
    Array.isArray(c.selections) &&
    c.selections.length === c.size &&
    isRatio(c.confidence) &&
    isPrice(c.combinedOdds) &&
    c.selections.every(validMarketSelection) &&
    new Set(c.selections.map((x) => x.matchId)).size === c.selections.length
  );
}
function couponValueTag(v) {
  if (!Number.isFinite(v)) return '<span class="tag muted">Valeur face au marché : —</span>';
  if (v > 0) return '<span class="tag ok">Valeur face au marché ' + signedPercent(v) + '</span>';
  if (Math.abs(v) <= 1e-9) return '<span class="tag muted">À la cote juste</span>';
  return '<span class="tag muted">Sous la cote juste ' + signedPercent(v) + '</span>';
}
function couponAge(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return 'Âge de la cote indisponible';
  const m = Math.floor(minutes);
  return (
    'Cote relevée il y a ' + (m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min')
  );
}
function couponFairOdd(x) {
  return isPrice(x.fairOdds) ? x.fairOdds : 1 / x.marketProbability;
}
function couponMinimumOdd(x) {
  const fairOdd = couponFairOdd(x);
  return Math.ceil((fairOdd - Number.EPSILON) * 100) / 100;
}
function couponValue(x) {
  // `null` signifie que le serveur n'a pas pu établir une comparaison récente.
  // Ne pas remplacer cette absence par un calcul à partir de la probabilité.
  if (x.valueVsMarket === null) return null;
  if (Number.isFinite(x.valueVsMarket)) return x.valueVsMarket;
  return (x.odd * x.marketProbability - 1) * 100;
}
function couponValueReason(x) {
  return typeof x.valueReason === 'string'
    ? x.valueReason
    : typeof x.reason === 'string'
      ? x.reason
      : '';
}
function couponSelectionHTML(x) {
  const minimumOdd = couponMinimumOdd(x);
  const fairOdd = frOdd(minimumOdd);
  const valuePercent = couponValue(x);
  const agreed = x.modelCheck === 'ok';
  return (
    '<li class="mcpick"><div class="mcmatch"><b class="matchname" title="' +
    esc(x.match) +
    '">' +
    esc(x.match) +
    '</b><span class="meta">' +
    kickoff(x.kickoff) +
    '</span></div><p class="mcbet">' +
    esc(x.market) +
    ' · <strong>' +
    esc(x.selection) +
    '</strong></p><dl class="mcfacts"><div><dt>Probabilité du marché</dt><dd>' +
    frPercent(x.marketProbability) +
    '</dd></div><div><dt>Cote bet365</dt><dd>' +
    frOdd(x.odd) +
    '</dd></div><div><dt>Cote juste du marché</dt><dd>' +
    fairOdd +
    '</dd></div></dl><div class="mctags">' +
    couponValueTag(valuePercent === null ? NaN : valuePercent / 100) +
    (valuePercent === null && couponValueReason(x)
      ? '<small>' + esc(couponValueReason(x)) + '</small>'
      : '') +
    '<span class="tag ' +
    (agreed ? 'ok' : 'muted') +
    '">' +
    (agreed ? 'Modèle d’accord' : 'Non vérifié') +
    '</span></div><span class="oddsage">' +
    esc(couponAge(x.oddsAgeMinutes)) +
    ' · Joue seulement si la cote actuelle est ≥ ' +
    minimumOdd.toFixed(2).replace('.', ',') +
    '.' +
    '</span></li>'
  );
}
function marketCouponHTML(c, index) {
  const id = 'mc' + index;
  return (
    '<article class="mcoupon" aria-labelledby="' +
    id +
    '"><header class="mchead"><div><h3 id="' +
    id +
    '">Coupon ' +
    (index + 1) +
    '</h3><span class="meta">' +
    COUPON_SIZES[c.size] +
    ' · ' +
    c.size +
    (c.size > 1 ? ' événements' : ' événement') +
    '</span></div><dl class="mctotals"><div><dt>Confiance</dt><dd class="prob">' +
    frPercent(c.confidence) +
    '</dd></div><div><dt>Cote combinée bet365</dt><dd>' +
    frOdd(c.combinedOdds) +
    '</dd></div></dl></header><ol class="mcpicks">' +
    c.selections.map(couponSelectionHTML).join('') +
    '</ol></article>'
  );
}
// États : attente, chargement, erreur (pas de champ), vide (motif) et succès.
function marketCouponsState(state, d = {}) {
  const box = $('#marketCoupons');
  if (!box) return;
  if (state === 'loading') {
    box.innerHTML = '<p class="mcmsg">Calcul des coupons du jour en cours…</p>';
    return;
  }
  if (state === 'idle') {
    box.innerHTML =
      '<p class="mcmsg">Les coupons du jour apparaissent ici après l’analyse des matchs filtrés.</p>';
    return;
  }
  const raw = d.marketCoupons;
  if (!Array.isArray(raw)) {
    box.innerHTML =
      '<p class="mcmsg"><strong>Coupons indisponibles pour cette analyse.</strong> ' +
      esc(d.summary || 'Le serveur n’a pas fourni de coupons.') +
      ' Aucun coupon n’est inventé.</p>';
    return;
  }
  if (raw.length && !raw.some(validMarketCoupon)) {
    box.innerHTML =
      '<p class="mcmsg"><strong>Données de coupons invalides.</strong> La réponse du serveur ne respecte pas le contrat attendu ; aucun coupon n’est affiché.</p>';
    return;
  }
  const list = raw.filter(validMarketCoupon);
  if (!list.length) {
    box.innerHTML =
      '<p class="mcmsg"><strong>Aucun coupon aujourd’hui.</strong> ' +
      (d.verdict === 'api_paused' || d.verdict === 'insufficient'
        ? esc(d.summary || '')
        : 'Aucun événement ne réunit une probabilité de marché entre 70 et 85 %, une cote bet365 relevée il y a moins de 24 h et un coupon d’au moins 50 % de confiance.') +
      ' Ne pas jouer reste une issue normale.</p>';
    return;
  }
  box.innerHTML =
    '<p class="note mcwarn" role="note">' +
    esc(COUPON_WARNING) +
    '</p>' +
    list.map(marketCouponHTML).join('');
}
function eventHTML(x, market, role, index) {
  return (
    '<div class="eventitem"><b>' +
    esc(x.match) +
    '</b><br>' +
    esc(x.market) +
    ' · ' +
    esc(x.selection) +
    ' @ ' +
    Number(x.odd).toFixed(2) +
    oddsAgeHTML(x.updated) +
    oddsWarningHTML(x) +
    '<br><span class="tag ' +
    (x.status === 'simulation_eligible' ? 'ok' : '') +
    '">' +
    verdictLabel(x.status) +
    '</span>' +
    valueBadge(valueCheck(market, role, index, x)) +
    (x.probability !== null && x.probability !== undefined
      ? '<p class="note">Estimation exploratoire : ' +
        (x.probability * 100).toFixed(1) +
        ' % · Scénario prudent : ' +
        (x.prudentProbability * 100).toFixed(1) +
        ' %<br>Seuil du bookmaker : ' +
        (x.breakEven * 100).toFixed(1) +
        ' % · Avantage prudent : ' +
        (x.prudentEdge * 100).toFixed(1) +
        ' % · ' +
        esc(x.bookmaker) +
        '</p>'
      : '') +
    '<p class="note">' +
    (x.reasons || []).map(esc).join('<br>') +
    '</p></div>'
  );
}
function pickHTML(x, market, index) {
  return (
    '<li class="pick"><span class="crests">' +
    String(x.match ?? '')
      .split(' — ')
      .map((team) => crest(team))
      .join('') +
    '</span><div><b class="matchname" title="' +
    esc(x.match) +
    '">' +
    esc(x.match) +
    '</b><span class="meta">' +
    esc(x.market) +
    ' · ' +
    esc(x.selection) +
    ' · ' +
    kickoff(x.kickoff) +
    '</span>' +
    oddsAgeHTML(x.updated) +
    oddsWarningHTML(x) +
    '</div><span class="odd"><span class="visually-hidden">Cote </span>' +
    Number(x.odd).toFixed(2) +
    '</span>' +
    valueBadge(valueCheck(market, 'selection', index, x)) +
    '</li>'
  );
}
// Candidats écartés par le seuil du ticket : tous ceux du serveur (pas seulement les cinq
// transmis au LLM), chacun avec son badge de valeur ou la raison de son absence.
function candidatesHTML(market) {
  const list = (market?.checks || []).filter((c) => c.role === 'excluded');
  if (!list.length) return '';
  return (
    '<details class="more candidates"><summary>Candidats écartés (' +
    list.length +
    ')</summary><p class="note">Hors ticket : les ajouter ferait passer la probabilité du ticket sous le seuil.</p>' +
    list
      .map(
        (c) =>
          '<div class="eventitem"><b>' +
          esc(c.match ?? 'Match ' + (c.matchId ?? '—')) +
          '</b><br>' +
          esc(c.marketName ?? '—') +
          ' · ' +
          esc(c.selection ?? '—') +
          (Number.isFinite(c.odd) ? ' @ ' + c.odd.toFixed(2) : '') +
          (c.bookmaker ? ' · ' + esc(c.bookmaker) : '') +
          oddsAgeHTML(c.updated) +
          valueBadge(c) +
          '</div>',
      )
      .join('') +
    '</details>'
  );
}
// Le ticket du jour : sélections, bookmaker, cote combinée et, si l'API la fournit,
// la probabilité combinée (ticketProbability). Rien n'est recalculé ici.
function showAssistant(d) {
  marketCouponsState('result', d);
  const box = $('#assistantResult');
  box.classList.remove('hidden');
  const picks = d.selections || [],
    reviews = d.reviews || [];
  const notes = [
    ...(d.reasons || []),
    ...(d.risks || []),
    ...(d.blockers || []),
    ...(d.llmError ? ['LLM : ' + d.llmError.code + ' · ' + (d.llmError.message || '')] : []),
  ];
  box.innerHTML =
    '<div class="verdict"><span class="tag ' +
    (d.verdict === 'simulation_eligible' ? 'ok' : '') +
    '">' +
    verdictLabel(d.verdict) +
    '</span><span class="meta">' +
    (!picks.length && reviews.length ? 'Examen de votre coupon · ' : '') +
    (d.engine === 'llm' ? 'Statistiques + explication LLM' : 'Moteur statistique') +
    '</span></div><p class="summary">' +
    esc(d.summary) +
    '</p>' +
    (picks.length
      ? '<ol class="picks">' +
        picks.map((x, i) => pickHTML(x, d.market, i)).join('') +
        '</ol><dl class="ticketfacts"><div><dt>Bookmaker</dt><dd>' +
        esc([...new Set(picks.map((x) => x.bookmaker))].join(', ')) +
        '</dd></div>' +
        (Number.isFinite(d.combinedOdds)
          ? '<div><dt>Cote combinée</dt><dd>' + d.combinedOdds.toFixed(2) + '</dd></div>'
          : '') +
        (Number.isFinite(d.ticketProbability)
          ? '<div><dt>Probabilité du ticket</dt><dd class="prob">' +
            (d.ticketProbability * 100).toFixed(1) +
            ' %<small>estimation prudente du serveur, non calibrée' +
            (Number.isFinite(d.minTicketProbability)
              ? ' · seuil ' + (d.minTicketProbability * 100).toFixed(0) + ' %'
              : '') +
            '</small></dd></div>'
          : '') +
        valueFact(d.market) +
        '</dl>'
      : reviews.length && d.market
        ? '<dl class="ticketfacts">' + valueFact(d.market) + '</dl>'
        : '') +
    (d.analyzed !== undefined
      ? '<p class="note coverage">' +
        d.analyzed +
        ' match(s) examinés / ' +
        d.eligibleCount +
        ' dans le périmètre. ' +
        (d.coverageComplete
          ? 'Tous les matchs du périmètre ont été examinés.'
          : 'Couverture partielle : ne pas interpréter cette analyse comme exhaustive.') +
        ' Aucune validation pour argent réel.</p>'
      : '') +
    (notes.length || reviews.length || picks.length
      ? '<details class="more"' +
        (picks.length ? '' : ' open') +
        '><summary>' +
        (picks.length ? 'Voir le détail de l’analyse' : 'Motifs et réserves') +
        '</summary>' +
        (notes.length
          ? '<ul class="reasons">' + notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>'
          : '') +
        reviews.map((x, i) => eventHTML(x, d.market, 'review', i)).join('') +
        picks.map((x, i) => eventHTML(x, d.market, 'selection', i)).join('') +
        '</details>'
      : '') +
    (picks.length
      ? '<button id="useProposal" class="btn primary block">Copier dans mon coupon</button>'
      : '') +
    candidatesHTML(d.market);
  if ($('#useProposal'))
    $('#useProposal').onclick = () => {
      if (coupon.length && !confirm('Remplacer le coupon actuel ?')) return;
      coupon = d.selections.slice(0, 4);
      // Valeur fournie par le serveur, reprise telle quelle dans la note du coupon : elle
      // reste visible même quand « Examiner mon coupon » remplace le ticket affiché.
      ticketCopy = {
        items: coupon.slice(),
        probability: Number.isFinite(d.ticketProbability) ? d.ticketProbability : null,
      };
      renderCoupon();
      toast('Ticket du jour copié dans votre coupon.');
    };
}
let assistantBusy = false;
async function collectReports(ids, gen, jobId = null) {
  const tokens = [],
    errors = [];
  for (let i = 0; i < ids.length; i++) {
    if (gen !== generation) throw Error('Filtres modifiés : analyse interrompue.');
    $('#assistantResult').textContent =
      'Analyse ' + (i + 1) + ' / ' + ids.length + ' · forme, absences, compositions et prix…';
    try {
      const d = await post('/api/assistant/scan', { matchId: ids[i], ...(jobId ? { jobId } : {}) });
      if (d.token) tokens.push(d.token);
    } catch (e) {
      if (e.code === 'API_RATE_LIMIT') throw e;
      errors.push('Match ' + ids[i] + ' : ' + e.message);
    }
  }
  return { tokens, errors };
}
function busy(value) {
  assistantBusy = value;
  $('#propose').disabled = value;
  $('#review').disabled = value;
}
async function collectQuotes(plan, gen) {
  for (const day of plan.quoteDays) {
    let page = 1,
      total = 1;
    do {
      if (gen !== generation) throw Error('Filtres modifiés : analyse interrompue.');
      $('#assistantResult').textContent =
        'Lecture des cotes · ' +
        (plan.quoteMode === 'fixtures' ? 'match ' + day : day) +
        ' · page ' +
        page +
        ' / ' +
        total +
        '…';
      const d = await post('/api/assistant/quotes', { jobId: plan.jobId, day, page });
      total = d.total;
      page++;
    } while (page <= total);
  }
}
$('#propose').onclick = async () => {
  if (assistantBusy) return;
  const scope = {
    date: $('#date').value,
    country: $('#country').value,
    league: $('#league').value,
    search: $('#search').value,
  };
  const gen = generation;
  busy(true);
  marketCouponsState('loading');
  $('#assistantResult').classList.remove('hidden');
  $('#assistantResult').textContent = 'Recherche de tous les matchs à venir…';
  try {
    const plan = await post('/api/assistant/prepare', scope);
    if (gen !== generation) return;
    if (!plan.ids.length) {
      showAssistant({
        engine: 'statistics',
        verdict: 'insufficient',
        summary: 'Aucun match encore à venir pour ces filtres.',
        analyzed: 0,
        eligibleCount: 0,
        coverageComplete: true,
      });
      return;
    }
    await collectQuotes(plan, gen);
    const scanned = await collectReports(plan.ids, gen, plan.jobId);
    if (gen !== generation) return;
    let d;
    do {
      $('#assistantResult').textContent =
        'Comparaison des événements sur ' + plan.ids.length + ' matchs…';
      d = await post('/api/assistant/propose', { jobId: plan.jobId });
      if (gen !== generation) return;
      for (const id of d.needsRecheck || []) {
        $('#assistantResult').textContent =
          'Dernière vérification des matchs et des cotes du coupon…';
        await post('/api/assistant/scan', { jobId: plan.jobId, matchId: id, recheck: true });
        if (gen !== generation) return;
      }
    } while (d.needsRecheck?.length);
    d.blockers = [...(d.blockers || []), ...scanned.errors];
    showAssistant(d);
  } catch (e) {
    if (gen === generation)
      showAssistant({
        engine: 'statistics',
        verdict: e.code === 'API_RATE_LIMIT' ? 'api_paused' : 'insufficient',
        summary: e.message,
      });
  } finally {
    busy(false);
  }
};
$('#review').onclick = async () => {
  if (assistantBusy) return;
  if (!coupon.length) return toast('Composez d’abord votre coupon.');
  const snapshot = JSON.stringify(coupon),
    gen = generation;
  busy(true);
  $('#assistantResult').classList.remove('hidden');
  try {
    const scanned = await collectReports([...new Set(coupon.map((x) => x.matchId))], gen);
    if (JSON.stringify(coupon) !== snapshot || gen !== generation) return;
    const d = await post('/api/assistant/review', { selections: coupon, tokens: scanned.tokens });
    if (JSON.stringify(coupon) !== snapshot || gen !== generation) return;
    d.blockers = [...(d.blockers || []), ...scanned.errors];
    showAssistant(d);
    $('#couponReview').textContent = verdictLabel(d.verdict) + ' · ' + d.summary;
  } catch (e) {
    if (gen === generation) {
      showAssistant({ engine: 'statistics', verdict: 'insufficient', summary: e.message });
      $('#couponReview').textContent = e.message;
    }
  } finally {
    busy(false);
  }
};
async function loadPerformance() {
  try {
    const p = await get('/api/performance');
    const pct = (v) => (v === null ? 'en attente' : (v * 100).toFixed(1) + ' %');
    const interval = (v) =>
      Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)
        ? '<small>IC 95 % : ' +
          (v[0] * 100).toFixed(1) +
          ' à ' +
          (v[1] * 100).toFixed(1) +
          ' %</small>'
        : '';
    if (p.available)
      $('#performance').innerHTML =
        '<div class="perfgrid"><div><strong>' +
        esc(p.recordedCoupons) +
        '</strong><span>propositions conservées</span></div><div><strong>' +
        esc(p.settledSelections) +
        '</strong><span>sélections réglées</span></div><div><strong>' +
        pct(p.winRate) +
        '</strong><span>taux de réussite</span>' +
        interval(p.winRateCI) +
        '</div><div><strong>' +
        pct(p.simulatedROI) +
        '</strong><span>rendement fictif</span>' +
        interval(p.roiCI) +
        '</div></div><p class="note">' +
        (typeof p.sampleWarningText === 'string' ? esc(p.sampleWarningText) + ' ' : '') +
        'Modèle non validé.</p>';
    else $('#performance').textContent = 'Suivi serveur indisponible.';
  } catch {
    $('#performance').textContent = 'Suivi serveur temporairement indisponible.';
  }
}
async function loadLatest() {
  try {
    const x = await get('/api/assistant/latest?date=' + $('#date').value);
    if (
      x.available &&
      Date.now() - Date.parse(x.data.generatedAt) < 1800000 &&
      !(x.data.selections || []).some(
        (s) => !fresh(s.updated) || Date.parse(s.kickoff) <= Date.now(),
      ) &&
      !assistantBusy
    )
      showAssistant(x.data);
  } catch {}
}
calc();
renderCoupon();
renderJournal();
init();
assistantInit();
loadPerformance();
loadLatest();
if (typeof setInterval === 'function')
  setInterval(() => {
    if (
      activeView === 'today' &&
      !assistantBusy &&
      !loading &&
      !current &&
      document.visibilityState === 'visible'
    )
      load();
  }, 15 * 60000);
