const $ = (s) => document.querySelector(s);
const esc = (x) =>
  String(x ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const tz = 'Etc/GMT+5';
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
function fresh(s) {
  const age = Date.now() - Date.parse(s);
  return Number.isFinite(age) && age >= -300000 && age <= 30 * 60000;
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
    $('#connection').textContent =
      (d.subscription?.plan || 'API') + ' · ' + (d.subscription?.active ? 'actif' : 'inactif');
    $('#quota').textContent = (d.requests?.limit_day || '—').toLocaleString('fr-CA');
  } catch (e) {
    $('#connection').textContent = 'Connexion à vérifier';
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
  $('#visibleCount').textContent = rows.length + ' MATCHS';
  $('#matches').classList.remove('loader');
  $('#matches').innerHTML = rows.length
    ? visible
        .map((f) => {
          const o = odds.get(f.fixture.id);
          return (
            '<article class="match"><div class="time">' +
            time(f.fixture.date) +
            '<small>' +
            esc(f.fixture.status.short) +
            '</small></div><div><div class="league">' +
            esc(f.league.country) +
            ' / ' +
            esc(f.league.name) +
            '</div><div class="teams">' +
            esc(f.teams.home.name) +
            '<span>vs</span>' +
            esc(f.teams.away.name) +
            '</div></div><div class="right"><span class="tag ' +
            (o && !fresh(o.update) ? 'warn' : '') +
            '">' +
            (o ? (fresh(o.update) ? 'Cotes récentes' : 'Cotes anciennes') : 'Cotes non chargées') +
            '</span><br><button class="btn light" data-match="' +
            f.fixture.id +
            '">Analyse →</button></div></article>'
          );
        })
        .join('')
    : '<div class="empty">Aucun match ne correspond aux filtres. Les cotes sont chargées progressivement : leur absence ici ne prouve pas leur absence chez le fournisseur.</div>';
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
  render();
}
$('#refresh').onclick = () => load();
$('#date').onchange = () => load();
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
function formHTML(a) {
  return a.length
    ? a
        .map(
          (f) =>
            '<div class="formrow"><i class="' +
            f.result +
            '">' +
            f.result +
            '</i><span>' +
            esc(f.opponent) +
            '</span><b style="margin-left:auto">' +
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
    $('#details').innerHTML =
      '<button class="btn light" id="back">← Le programme</button><p class="eyebrow" style="margin-top:25px">' +
      esc(f.league.name) +
      ' / ' +
      stamp(f.fixture.date) +
      '</p><h2 class="bigtitle">' +
      esc(f.teams.home.name) +
      '<br><span style="color:var(--orange)">vs ' +
      esc(f.teams.away.name) +
      '</span></h2><div class="notice">' +
      (Object.keys(d.errors).length ? 'Certaines sources sont indisponibles. ' : '') +
      'Données consultées : ' +
      stamp(d.retrievedAt) +
      '. Compositions ' +
      (d.lineups.length ? 'disponibles' : 'non disponibles') +
      '. ' +
      d.injuries.length +
      ' absence(s) signalée(s) — une liste vide ne confirme pas un effectif complet.</div><div class="grid"><div class="panel"><h3>' +
      esc(f.teams.home.name) +
      '</h3><p class="note">' +
      a.length +
      ' matchs terminés récents</p>' +
      formHTML(a) +
      '</div><div class="panel"><h3>' +
      esc(f.teams.away.name) +
      '</h3><p class="note">' +
      b.length +
      ' matchs terminés récents</p>' +
      formHTML(b) +
      '</div></div><div class="panel"><span class="eyebrow">Modèle exploratoire / Non validé</span>' +
      (m
        ? '<div class="grid"><div><p>Plus de 2,5 buts</p><strong class="number">' +
          Math.round(m.over * 100) +
          ' %</strong><div class="bar"><span style="width:' +
          m.over * 100 +
          '%"></span></div></div><div><p>Les deux équipes marquent</p><strong class="number">' +
          Math.round(m.btts * 100) +
          ' %</strong><div class="bar"><span style="width:' +
          m.btts * 100 +
          '%"></span></div></div></div><p class="note">Poisson indépendant · Moyennes des ' +
          a.length +
          ' et ' +
          b.length +
          ' matchs terminés. Aucune correction de force des adversaires, domicile, blessures ou composition. Ces chiffres ne déclenchent aucune recommandation.</p>'
        : '<p class="note">Historique insuffisant : au moins huit matchs terminés par équipe sont nécessaires pour cette exploration.</p>') +
      '</div><div class="panel"><h3>Absences & compositions</h3><p class="note">' +
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
      '</div><div class="panel"><h3>Les marchés & leur prix</h3><p class="note">Seuil = 1 ÷ cote. Ce tableau ne calcule pas de valeur attendue pour les marchés non modélisés. L’ajout au coupon est une simulation choisie manuellement. Les règles de règlement du bookmaker restent à vérifier.</p><select id="book" aria-label="Bookmaker"></select><div id="marketTable" class="scroll"></div></div>';
    $('#back').onclick = () => {
      advanceGeneration();
      current = null;
      $('#details').classList.add('hidden');
      $('#program').classList.remove('hidden');
    };
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
      '<button class="btn light" id="back">← Le programme</button><p id="detailError">' +
      esc(e.message) +
      '</p>';
    $('#back').onclick = () => {
      advanceGeneration();
      current = null;
      $('#details').classList.add('hidden');
      $('#program').classList.remove('hidden');
    };
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
    (available ? '' : ' · Ajout bloqué : cote ancienne, horaire passé ou match déjà commencé.') +
    '</p><table><thead><tr><th>Marché / sélection</th><th>Cote</th><th>Seuil</th><th></th></tr></thead><tbody>' +
    marketChoices
      .map(
        (x, i) =>
          '<tr><td>' +
          esc(x.market) +
          '<br><b>' +
          esc(x.selection) +
          '</b></td><td>' +
          x.odd.toFixed(2) +
          '</td><td>' +
          (100 / x.odd).toFixed(1) +
          ' %</td><td><button class="btn light" data-add="' +
          i +
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
            '<div class="couponitem"><button data-remove="' +
            i +
            '" aria-label="Retirer la sélection">×</button><b>' +
            esc(x.match) +
            '</b><br>' +
            esc(x.market) +
            ' · ' +
            esc(x.selection) +
            '<br><b>' +
            x.odd.toFixed(2) +
            '</b> · ' +
            esc(x.bookmaker) +
            '<br><span class="note">Cote du ' +
            stamp(x.updated) +
            '</span></div>',
        )
        .join('')
    : '<div class="empty" style="margin-top:15px">Aucune sélection.<br>Ouvre une fiche pour examiner les cotes.</div>';
  $('#combined').textContent = coupon.length ? total.toFixed(2) : '—';
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
            '<div class="couponitem"><b>' +
            stamp(x.createdAt) +
            '</b><p>' +
            x.selections.map((s) => esc(s.match) + ' / ' + esc(s.selection)).join('<br>') +
            '</p><span>Mise fictive ' +
            x.stake +
            ' CAD · Cote ' +
            x.odd.toFixed(2) +
            '</span><br><select data-result="' +
            x.id +
            '" aria-label="Résultat manuel"><option value="pending" ' +
            (x.result === 'pending' ? 'selected' : '') +
            '>En attente</option><option value="won" ' +
            (x.result === 'won' ? 'selected' : '') +
            '>Gagné</option><option value="lost" ' +
            (x.result === 'lost' ? 'selected' : '') +
            '>Perdu</option><option value="void" ' +
            (x.result === 'void' ? 'selected' : '') +
            '>Entièrement annulé</option></select><p class="note">' +
            (x.result === 'won'
              ? 'Bénéfice simulé : ' + (x.stake * (x.odd - 1)).toFixed(2) + ' CAD'
              : x.result === 'lost'
                ? 'Perte simulée : ' + x.stake + ' CAD'
                : x.result === 'void'
                  ? 'Mise fictive restituée'
                  : 'Résultat non renseigné') +
            '</p></div>',
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
      document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
      ['today', 'journal', 'method'].forEach((id) =>
        $('#' + id).classList.toggle('hidden', id !== b.dataset.view),
      );
    }),
);

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
function eventHTML(x) {
  return (
    '<div class="couponitem"><b>' +
    esc(x.match) +
    '</b><br>' +
    esc(x.market) +
    ' · ' +
    esc(x.selection) +
    ' @ ' +
    Number(x.odd).toFixed(2) +
    '<br><span class="tag ' +
    (x.status === 'simulation_eligible' ? '' : 'warn') +
    '">' +
    verdictLabel(x.status) +
    '</span>' +
    (x.probability !== null && x.probability !== undefined
      ? '<p class="note">Estimation exploratoire : ' +
        (x.probability * 100).toFixed(1) +
        ' % · Scénario prudent : ' +
        (x.prudentProbability * 100).toFixed(1) +
        ' %<br>Seuil du bookmaker : ' +
        (x.breakEven * 100).toFixed(1) +
        ' % · Avantage prudent : ' +
        (x.prudentEdge * 100).toFixed(1) +
        ' %<br>Cote minimum : ' +
        (Number.isFinite(x.minOdds) ? x.minOdds.toFixed(2) : '—') +
        ' · ' +
        esc(x.bookmaker) +
        '</p>'
      : '') +
    '<p class="note">' +
    (x.reasons || []).map(esc).join('<br>') +
    '</p></div>'
  );
}
function showAssistant(d) {
  const box = $('#assistantResult');
  box.classList.remove('hidden');
  box.innerHTML =
    '<span class="eyebrow">' +
    (d.engine === 'llm' ? 'STATISTIQUES + EXPLICATION LLM' : 'MOTEUR STATISTIQUE') +
    '</span><h3 style="margin-top:12px">' +
    verdictLabel(d.verdict) +
    '</h3><p>' +
    esc(d.summary) +
    '</p><p class="note">' +
    [
      ...(d.reasons || []),
      ...(d.risks || []),
      ...(d.blockers || []),
      ...(d.llmError ? ['LLM : ' + d.llmError.code + ' · ' + (d.llmError.message || '')] : []),
    ]
      .map(esc)
      .join('<br>') +
    '</p>' +
    (d.analyzed !== undefined
      ? '<p class="note">' +
        d.analyzed +
        ' match(s) examinés / ' +
        d.eligibleCount +
        ' dans le périmètre. ' +
        (d.coverageComplete
          ? 'Tous les matchs du périmètre ont été examinés.'
          : 'Couverture partielle : ne pas interpréter cette analyse comme exhaustive.') +
        ' Aucune validation pour argent réel.</p>'
      : '') +
    (d.reviews || []).map(eventHTML).join('') +
    (d.selections?.length
      ? d.selections.map(eventHTML).join('') +
        '<button id="useProposal" class="btn orange">Utiliser ces sélections en simulation</button>'
      : '');
  if ($('#useProposal'))
    $('#useProposal').onclick = () => {
      if (coupon.length && !confirm('Remplacer le coupon actuel ?')) return;
      coupon = d.selections.slice(0, 4);
      renderCoupon();
      toast('Coupon de simulation ajouté.');
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
    $('#performance').textContent = p.available
      ? p.recordedCoupons +
        ' propositions conservées · ' +
        p.settledSelections +
        ' sélections réglées · Taux de réussite ' +
        (p.winRate === null ? 'en attente' : (p.winRate * 100).toFixed(1) + ' %') +
        ' · Rendement fictif ' +
        (p.simulatedROI === null ? 'en attente' : (p.simulatedROI * 100).toFixed(1) + ' %') +
        ' · Modèle non validé.'
      : 'Suivi serveur indisponible.';
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
