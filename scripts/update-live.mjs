// stdin only: {"token":"site service credential"}; never print or persist it.
let input = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.includes('\n')) {
    process.stdin.pause();
    main(JSON.parse(input)).catch((e) => {
      console.error(JSON.stringify({ error: e.message }));
      process.exit(1);
    });
  }
});
async function main({ token, date }) {
  const base = 'https://foot-decision-franck.stablelily4.chatgpt.site';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Etc/GMT+5',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (k) => parts.find((x) => x.type === k).value;
  date = date || part('year') + '-' + part('month') + '-' + part('day');
  const headers = {
    'OAI-Sites-Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
  };
  async function call(path, body) {
    const response = await fetch(base + path, {
      headers,
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(180000),
    });
    const value = await response.json();
    if (!response.ok) throw Error(path + ': ' + (value.error || response.status));
    return value;
  }
  const plan = await call('/api/assistant/prepare', { date });
  const errors = [];
  for (const day of plan.quoteDays) {
    let page = 1,
      total = 1;
    do {
      const d = await call('/api/assistant/quotes', { jobId: plan.jobId, day, page });
      total = d.total;
      page++;
    } while (page <= total);
  }
  for (const id of plan.ids)
    try {
      await call('/api/assistant/scan', { jobId: plan.jobId, matchId: id });
    } catch (e) {
      errors.push(e.message);
    }
  if (errors.length) throw Error('Analyse incomplète : aucun coupon écrit. ' + errors.join(' · '));
  let result;
  do {
    result = await call('/api/assistant/propose', { jobId: plan.jobId });
    for (const id of result.needsRecheck || [])
      await call('/api/assistant/scan', { jobId: plan.jobId, matchId: id, recheck: true });
  } while (result.needsRecheck?.length);
  const readback = await call('/api/assistant/latest?date=' + date);
  if (!readback.available || readback.data.generatedAt !== result.generatedAt)
    throw Error('Écriture du coupon non confirmée.');
  let settlement;
  try {
    settlement = await call('/api/assistant/settle', {});
  } catch (e) {
    settlement = { error: e.message };
  }
  console.log(
    JSON.stringify({
      date,
      analyzed: result.analyzed,
      eligibleCount: result.eligibleCount,
      verdict: result.verdict,
      selections: result.selections.length,
      saved: result.saved,
      readbackVerified: true,
      modelValidated: false,
      errors,
      settlement,
    }),
  );
  process.exit();
}
