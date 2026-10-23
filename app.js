// ==================== DATA ====================
const DEFAULT_CATEGORIES = {
  expense: ['Boodschappen', 'Eten & Drinken', 'Vervoer', 'Wonen', 'Abonnementen', 'Kleding', 'Gezondheid', 'Entertainment', 'Overig'],
  income: ['Salaris', 'Freelance', 'Terugbetaling', 'Cadeau', 'Overig']
};

const DATA_VERSION = 3;
const DEFAULT_PERIOD_START_DAY = 25;

let state = {
  version: DATA_VERSION,
  transactions: [],
  pots: [],
  goals: [],
  categories: { expense: [...DEFAULT_CATEGORIES.expense], income: [...DEFAULT_CATEGORIES.income] },
  settings: { periodStartDay: DEFAULT_PERIOD_START_DAY },
  lastPeriodStart: null,
  history: [],
  recurring: []
};

let currentPotId = null;

// ==================== STORAGE ====================
function loadState() {
  const saved = localStorage.getItem('mijnGeldApp');
  if (saved) {
    try {
      const parsed = JSON.parse(saved) || {};
      // Versie 1 trok potjes af van het saldo (saldo = in - uit - potjes). Versie 2 toont saldo = in - uit,
      // en 'Na potjes' = in - uit - potjes, wat precies het oude saldo is. Transacties en potbedragen
      // blijven dus ongewijzigd geldig; er wordt niets dubbel geteld. Alleen het versienummer wordt bijgewerkt.
      state = {
        version: DATA_VERSION,
        transactions: parsed.transactions || [],
        pots: parsed.pots || [],
        goals: parsed.goals || [],
        categories: parsed.categories || { expense: [...DEFAULT_CATEGORIES.expense], income: [...DEFAULT_CATEGORIES.income] },
        // Versie 3: periodes. Oude data krijgt startdag 25, maandbudget = huidig bedrag per potje,
        // en de laatst gestarte periode = de meest recente startdag (zodat de banner pas bij de volgende verschijnt).
        settings: parsed.settings || { periodStartDay: DEFAULT_PERIOD_START_DAY },
        lastPeriodStart: parsed.lastPeriodStart || null,
        history: Array.isArray(parsed.history) ? parsed.history : null,
        recurring: Array.isArray(parsed.recurring) ? parsed.recurring : []
      };
      ensurePeriodDefaults();
      if (parsed.version !== DATA_VERSION) saveState();
    } catch (e) {
      console.error('Kon data niet laden', e);
    }
  }
}

function ensurePeriodDefaults() {
  if (!state.settings) state.settings = { periodStartDay: DEFAULT_PERIOD_START_DAY };
  const day = parseInt(state.settings.periodStartDay, 10);
  state.settings.periodStartDay = Math.min(28, Math.max(1, isNaN(day) ? DEFAULT_PERIOD_START_DAY : day));
  state.pots.forEach(p => { if (typeof p.budget !== 'number') p.budget = p.balance; });
  if (!state.lastPeriodStart) state.lastPeriodStart = getCurrentPeriodStart();
  if (!Array.isArray(state.history)) state.history = buildHistoryFromPast();
  if (!Array.isArray(state.recurring)) state.recurring = [];
}

// Eerste keer (migratie): maak geschiedenis van bestaande transacties vóór de huidige periode,
// gegroepeerd per periode (op basis van de startdag). Budget/over per potje is dan onbekend.
function buildHistoryFromPast() {
  const groups = {};
  state.transactions.forEach(t => {
    const ymd = toYmd(new Date(t.date));
    if (ymd >= state.lastPeriodStart) return;
    const start = getCurrentPeriodStart(new Date(t.date));
    (groups[start] = groups[start] || []).push(t);
  });
  return Object.keys(groups).sort().reverse().map(start => {
    let end = addDaysYmd(addMonthsYmd(start, 1), -1);
    if (end >= state.lastPeriodStart) end = addDaysYmd(state.lastPeriodStart, -1);
    return makePeriodSnapshot(start, end, null);
  });
}

if (typeof window !== 'undefined') window.mgGetState = () => state;

function saveState() {
  localStorage.setItem('mijnGeldApp', JSON.stringify(state));
  if (typeof window !== 'undefined' && typeof window.mgSyncOnSave === 'function') { try { window.mgSyncOnSave(); } catch (e) {} }
}

// ==================== HELPERS ====================
// Negatieve bedragen als '−€ 120,00' (minteken vóór het euroteken) i.p.v. nl-NL's '€ -120,00', zodat een tekort meteen opvalt.
function formatMoney(amount) {
  const v = Math.round((amount || 0) * 100) / 100;
  const txt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Math.abs(v));
  return v < 0 ? '\u2212' + txt : txt;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Begin van de periode waarin 'date' valt: deze maand op de startdag, of anders vorige maand.
function getCurrentPeriodStart(date = new Date()) {
  const day = (state.settings && state.settings.periodStartDay) || DEFAULT_PERIOD_START_DAY;
  const start = new Date(date.getFullYear(), date.getMonth(), day);
  if (date.getDate() < day) start.setMonth(start.getMonth() - 1);
  return toYmd(start);
}

// Eerstvolgende startdag (betaaldag) ná 'ymd', volgens de huidige instelling.
function nextPeriodStartAfter(ymd) {
  const day = (state.settings && state.settings.periodStartDay) || DEFAULT_PERIOD_START_DAY;
  const [y, m, d] = ymd.split('-').map(Number);
  let next = new Date(y, m - 1, day);
  if (toYmd(next) <= ymd) next = new Date(y, m, day);
  return toYmd(next);
}

// Laatste dag van de periode die op 'start' begon: de dag vóór de volgende startdag.
// Na het wijzigen van de startdag wordt de lopende periode dus korter of langer, maar begint niet opnieuw.
function getPeriodEnd(start) {
  const next = nextPeriodStartAfter(start);
  const d = ymdToDate(next);
  d.setDate(d.getDate() - 1);
  return toYmd(d);
}

function ymdToDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDaysYmd(ymd, days) {
  const d = ymdToDate(ymd);
  d.setDate(d.getDate() + days);
  return toYmd(d);
}

function addMonthsYmd(ymd, months) {
  const d = ymdToDate(ymd);
  d.setMonth(d.getMonth() + months);
  return toYmd(d);
}

function txYmd(t) {
  return toYmd(new Date(t.date));
}

function transactionsBetween(start, end) {
  return state.transactions
    .filter(t => { const d = txYmd(t); return d >= start && (!end || d <= end); })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function formatShortDate(ymd, withYear = false) {
  const opts = { day: 'numeric', month: 'short' };
  if (withYear) opts.year = 'numeric';
  return ymdToDate(ymd).toLocaleDateString('nl-NL', opts);
}

function formatRange(start, end) {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${formatShortDate(start, !sameYear)} – ${formatShortDate(end, true)}`;
}

function isNewPeriodDue() {
  return !state.lastPeriodStart || state.lastPeriodStart < getCurrentPeriodStart();
}

function formatLongDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const startOf = x => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return 'Vandaag';
  if (diff === 1) return 'Gisteren';
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

// ==================== CALCULATIONS ====================
// Saldo = inkomsten - uitgaven - geld naar spaardoelen. Potjes zijn alleen gereserveerd geld en verlagen
// het saldo niet; pas bij uitgeven vanuit een potje (een uitgave) gaat het geld echt van het saldo af.
function getIncomeMinusExpense() {
  const income = state.transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = state.transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  return Math.round((income - expense) * 100) / 100;
}

function getAvailableBalance() {
  return Math.round((getIncomeMinusExpense() - getGoalTransfersTotal()) * 100) / 100;
}

// Spaardoelen (v29): elke storting/opname via de app wordt per doel gelogd in goal.deposits
// ([{ id, amount, date }], opname = negatief bedrag). Die bedragen gaan van het saldo af (of komen terug),
// net als uitgaven: één keer, en blijvend (niet alleen in de huidige periode). Het startbedrag ('Al gespaard')
// en bedragen van vóór v29 staan niet in het logboek: die zijn nooit van het saldo afgegaan en blijven dus buiten beschouwing.
function goalDeposits(g) {
  return Array.isArray(g && g.deposits) ? g.deposits.filter(d => d && typeof d.amount === 'number' && isFinite(d.amount)) : [];
}

function getGoalTransfersTotal(fromYmd, toYmd) {
  let sum = 0;
  (state.goals || []).forEach(g => goalDeposits(g).forEach(d => {
    if (fromYmd || toYmd) {
      const ymd = txYmd(d);
      if (fromYmd && ymd < fromYmd) return;
      if (toYmd && ymd > toYmd) return;
    }
    sum += d.amount;
  }));
  return Math.round(sum * 100) / 100;
}

// Netto naar spaardoelen in de huidige (salaris)periode.
function getGoalTransfersThisPeriod() {
  return getGoalTransfersTotal(state.lastPeriodStart);
}

// ==================== SPAARDOEL ELKE PERIODE RESETTEN (v32) ====================
// Een spaardoel met resetEachPeriod === true gaat op de betaaldag (start van een nieuwe periode volgens de
// startdag, dus automatisch, ook als je de nieuwe periode nog niet via de banner hebt gestart) terug naar € 0.
// - Het geld komt NIET terug op het beschikbaar saldo en de reset wordt NIET als opname in goal.deposits
//   gelogd: saldo, 'Deze periode naar spaardoelen' en Analyse blijven dus precies gelijk.
// - goal.lastResetPeriod (YYYY-MM-DD, startdatum van de periode) zorgt dat het hooguit één keer per periode
//   gebeurt: ook na meerdere gemiste periodes (dan één reset), bij later openen en op meerdere toestellen.
// - Aanzetten zet lastResetPeriod op de lopende periode: de eerste reset is dus pas op de volgende betaaldag.
let goalResetUnsynced = false;
function goalResetsEnabled(g) { return !!(g && g.resetEachPeriod === true); }

function runGoalResets(now = new Date()) {
  const period = getCurrentPeriodStart(now);
  const resets = [];
  (state.goals || []).forEach(g => {
    if (!goalResetsEnabled(g)) return;
    if (typeof g.lastResetPeriod !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(g.lastResetPeriod)) {
      g.lastResetPeriod = period; // oude/geïmporteerde data zonder markering: niet meteen resetten
      return;
    }
    if (g.lastResetPeriod >= period) return;
    const amount = Math.round((g.current || 0) * 100) / 100;
    g.current = 0;
    g.lastResetPeriod = period;
    g.lastResetAmount = amount;
    resets.push({ goal: g, amount });
  });
  if (resets.length) goalResetUnsynced = true;
  return resets;
}

// Voor sync.js: is er een reset gedaan die nog niet naar de cloud is? (leest en wist de vlag)
if (typeof window !== 'undefined') window.mgTakeGoalResetPending = () => { const v = goalResetUnsynced; goalResetUnsynced = false; return v; };

function goalResetToast(resets) {
  if (!resets.length) return;
  const msg = resets.length === 1
    ? `🔁 Nieuwe periode: "${resets[0].goal.name}" staat weer op ${formatMoney(0)}`
    : `🔁 Nieuwe periode: ${resets.length} spaardoelen staan weer op ${formatMoney(0)}`;
  setTimeout(() => showToast(msg), 1200);
}

// Wat er vrij te besteden is na aftrek van het geld in potjes.
function getBalanceAfterPots() {
  return Math.round((getAvailableBalance() - getPotsTotal()) * 100) / 100;
}

function getPotsTotal() {
  // Een potje in de min reserveert niets: het tekort is al via de uitgave van het saldo af.
  return Math.round(state.pots.reduce((s, p) => s + Math.max(0, p.balance), 0) * 100) / 100;
}

// Vaste lasten die deze periode nog komen en NIET al gedekt zijn door het gekoppelde potje.
// Een vaste last met een potje wordt bij het boeken van dat potje afgeschreven; dat geld is dus al
// gereserveerd en zit al in 'In potjes'. Alleen het deel dat het potje niet dekt, telt hier nog mee
// (anders zou dezelfde huur twee keer van 'Na potjes & vaste lasten' afgaan).
function getUpcomingFixedImpact(upcoming = getUpcomingRecurring()) {
  const pool = {};
  state.pots.forEach(p => { pool[p.id] = Math.max(0, p.balance); });
  let sum = 0;
  upcoming.forEach(r => {
    let amt = r.amount;
    if (r.potId && pool[r.potId] !== undefined) {
      const covered = Math.min(pool[r.potId], amt);
      pool[r.potId] -= covered;
      amt -= covered;
    }
    sum += amt;
  });
  return Math.round(sum * 100) / 100;
}

// Wat er echt vrij te besteden is: saldo − potjes − (niet door potjes gedekte) vaste lasten. Mag negatief zijn.
function getFreeToSpend(upcoming = getUpcomingRecurring()) {
  return Math.round((getBalanceAfterPots() - getUpcomingFixedImpact(upcoming)) * 100) / 100;
}

function getGoalsTotal() {
  return state.goals.reduce((s, g) => s + g.current, 0);
}

// ==================== RENDER ====================
function render() {
  const availEl = document.getElementById('available-balance');
  countUp(availEl, getAvailableBalance());
  availEl.classList.toggle('balance-neg', getAvailableBalance() < 0);
  const upcoming = getUpcomingRecurring();
  // Kan gewoon negatief worden (meer in potjes/vaste lasten dan je hebt): dan rood met minteken.
  const free = upcoming.length ? getFreeToSpend(upcoming) : getBalanceAfterPots();
  const afterEl = document.getElementById('after-pots');
  afterEl.innerHTML = `${upcoming.length ? 'Na potjes &amp; vaste lasten' : 'Na potjes'}: <span id="after-pots-amount" class="after-pots-amount${free < 0 ? ' is-negative' : ''}">${formatMoney(free)}</span>`;
  afterEl.classList.toggle('is-negative', free < 0);
  const activeCount = (state.recurring || []).filter(r => r.active).length;
  document.getElementById('settings-recurring-count').textContent = activeCount ? `${activeCount} actief` : '';
  countUp(document.getElementById('pots-total'), getPotsTotal());
  countUp(document.getElementById('goals-total'), getGoalsTotal());
  const goalsLine = document.getElementById('goals-line');
  if (goalsLine) {
    const gp = getGoalTransfersThisPeriod();
    goalsLine.classList.toggle('hidden', gp === 0);
    goalsLine.textContent = gp === 0 ? '' : `🎯 Deze periode ${gp < 0 ? 'uit spaardoelen: +' + formatMoney(-gp) : 'naar spaardoelen: −' + formatMoney(gp)}`;
  }

  renderTransactions();
  renderPots();
  renderGoals();
  populateCategorySelects();
  populatePotSelect();
  renderPeriodBanner();
  renderHistory();
  renderBackupBanner();
  if (!document.getElementById('panel-analysis').classList.contains('hidden')) renderAnalysis();
}

// ==================== ANALYSE ====================
let analysisPeriodKey = 'current';
const CHART_COLORS = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#0ea5e9', '#8b5cf6', '#ec4899', '#14b8a6', '#84cc16', '#64748b'];

function daysBetween(startYmd, endYmd) {
  return Math.round((ymdToDate(endYmd) - ymdToDate(startYmd)) / 86400000) + 1;
}

// Alle periodes, nieuwste eerst: de huidige + de afgesloten uit de geschiedenis.
function getAnalysisPeriods() {
  const todayYmd = toYmd(new Date());
  const nominalEnd = getPeriodEnd(state.lastPeriodStart);
  const current = {
    key: 'current', isCurrent: true, start: state.lastPeriodStart,
    end: todayYmd < nominalEnd ? todayYmd : nominalEnd, nominalEnd: todayYmd < nominalEnd ? nominalEnd : todayYmd,
    pots: state.pots.map(p => ({ id: p.id, name: p.name, emoji: p.emoji, budget: p.budget ?? null, leftover: p.balance }))
  };
  const past = [...state.history].sort((a, b) => b.start.localeCompare(a.start))
    .map(h => ({ key: h.id, isCurrent: false, start: h.start, end: h.end, nominalEnd: h.end, pots: h.pots || [] }));
  return [current, ...past];
}

function periodStats(p) {
  const txs = transactionsBetween(p.start, p.isCurrent ? null : p.end);
  const r = x => Math.round(x * 100) / 100;
  const expenses = txs.filter(t => t.type === 'expense');
  const income = r(txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0));
  const expense = r(expenses.reduce((s, t) => s + t.amount, 0));
  const categories = {};
  expenses.forEach(t => { categories[t.category] = r((categories[t.category] || 0) + t.amount); });
  const spentByPot = {};
  expenses.filter(t => t.potId).forEach(t => { spentByPot[t.potId] = r((spentByPot[t.potId] || 0) + t.amount); });
  const days = Math.max(1, daysBetween(p.start, p.end));
  const fixed = r(expenses.filter(t => t.recurringId).reduce((s, t) => s + t.amount, 0));
  // Spaardoelen (los van uitgaven): netto stortingen in deze periode, opnames negatief.
  const endYmd = p.isCurrent ? null : p.end;
  const savedByGoal = {};
  (state.goals || []).forEach(g => goalDeposits(g).forEach(d => {
    const ymd = txYmd(d);
    if (ymd < p.start || (endYmd && ymd > endYmd)) return;
    savedByGoal[g.id] = r((savedByGoal[g.id] || 0) + d.amount);
  }));
  const saved = r(Object.values(savedByGoal).reduce((a, b) => a + b, 0));
  return { txs, expenses, income, expense, fixed, net: r(income - expense), categories, spentByPot, days,
    saved, savedByGoal, leftAfterSaving: r(income - expense - saved),
    savedRate: income > 0 ? saved / income * 100 : null,
    perDay: expense / days, savingsRate: income > 0 ? (income - expense) / income * 100 : null };
}

function formatPct(x, digits = 0) {
  return new Intl.NumberFormat('nl-NL', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(x) + '%';
}

function changeBadge(cur, prev, goodWhenUp) {
  if (prev == null || !isFinite(prev) || prev === 0 || cur == null) return '<span class="text-[11px] text-slate-300">–</span>';
  const ch = (cur - prev) / Math.abs(prev) * 100;
  if (Math.abs(ch) < 0.5) return '<span class="text-[11px] font-semibold text-slate-400">= gelijk</span>';
  const up = ch > 0, good = up === goodWhenUp;
  return `<span class="text-[11px] font-semibold ${good ? 'text-emerald-600' : 'text-rose-600'}">${up ? '↑' : '↓'} ${formatPct(Math.abs(ch))}</span>`;
}

// Verschil in procentpunten (voor het spaarpercentage).
function pointsBadge(cur, prev) {
  if (cur == null || prev == null || !isFinite(prev)) return '<span class="text-[11px] text-slate-300">–</span>';
  const d = cur - prev;
  if (Math.abs(d) < 0.5) return '<span class="text-[11px] font-semibold text-slate-400">= gelijk</span>';
  return `<span class="text-[11px] font-semibold ${d > 0 ? 'text-emerald-600' : 'text-rose-600'}">${d > 0 ? '↑' : '↓'} ${Math.round(Math.abs(d))} %-punt</span>`;
}

function card(title, body, extra = '') {
  return `<div class="bg-white rounded-2xl p-4 shadow-card border border-slate-100/60">
    <div class="flex items-center justify-between mb-3"><h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider">${title}</h3>${extra}</div>
    ${body}</div>`;
}

const emptyNote = text => `<p class="text-sm text-slate-400 text-center py-4">${text}</p>`;

function selectAnalysisPeriod(key) {
  setTimeout(animateCharts, 0);
  analysisPeriodKey = key;
  renderAnalysis();
}

function renderAnalysis() {
  const periods = getAnalysisPeriods();
  if (!periods.some(p => p.key === analysisPeriodKey)) analysisPeriodKey = 'current';
  const select = document.getElementById('analysis-period');
  select.innerHTML = periods.map(p => `<option value="${p.key}">${p.isCurrent ? 'Huidige periode' : formatRange(p.start, p.end)}</option>`).join('');
  select.value = analysisPeriodKey;

  const idx = periods.findIndex(p => p.key === analysisPeriodKey);
  const period = periods[idx];
  const prevPeriod = periods[idx + 1] || null;
  const s = periodStats(period);
  const prev = prevPeriod ? periodStats(prevPeriod) : null;
  const el = document.getElementById('analysis-content');

  const rangeLabel = period.isCurrent
    ? `${formatShortDate(period.start)} – vandaag · dag ${daysBetween(period.start, period.end)} van ${daysBetween(period.start, period.nominalEnd)}`
    : `${formatRange(period.start, period.end)} · ${s.days} dagen`;

  // --- Kerncijfers ---
  const tile = (label, value, badge, cls = 'text-slate-900') => `
    <div class="bg-slate-50 rounded-2xl p-3">
      <p class="text-xs text-slate-400">${label}</p>
      <p class="font-bold text-[17px] tabular-nums mt-0.5 ${cls}">${value}</p>
      <div class="mt-0.5">${badge}</div>
    </div>`;
  const kpis = `
    <p class="text-xs text-slate-400 -mt-1 mb-3 tabular-nums">${rangeLabel}</p>
    <div class="grid grid-cols-2 gap-2">
      ${tile('Inkomsten', formatMoney(s.income), changeBadge(s.income, prev && prev.income, true), 'text-emerald-600')}
      ${tile('Uitgaven', formatMoney(s.expense), changeBadge(s.expense, prev && prev.expense, false), 'text-rose-600')}
      ${tile('🎯 Gespaard', (s.saved < 0 ? '−' : '') + formatMoney(Math.abs(s.saved)),
        `<span class="text-[11px] text-slate-400">${s.savedRate == null ? 'naar spaardoelen' : formatPct(s.savedRate) + ' van inkomsten'}</span>`, 'goal-text')}
      ${tile('Netto', (s.net >= 0 ? '+' : '−') + formatMoney(Math.abs(s.net)), changeBadge(s.net, prev && prev.net, true), s.net >= 0 ? 'text-slate-900' : 'text-rose-600')}
      ${tile('Niet uitgegeven', s.savingsRate == null ? '–' : formatPct(s.savingsRate), pointsBadge(s.savingsRate, prev && prev.savingsRate))}
      ${tile('Gem. uitgave per dag', formatMoney(s.perDay), changeBadge(s.perDay, prev && prev.perDay, false))}
    </div>
    <p class="text-[11px] text-slate-400 mt-2">Gespaard = wat je naar je spaardoelen hebt gezet (opnames eraf). Dat telt niet als uitgave. Netto = inkomsten − uitgaven; daarvan ${s.saved !== 0 ? `ging ${formatMoney(s.saved)} naar spaardoelen en bleef ${formatMoney(s.leftAfterSaving)} over` : 'ging niets naar spaardoelen'}.</p>
    ${s.fixed > 0 ? `
    <div class="mt-3 bg-slate-50 rounded-2xl p-3">
      <div class="flex items-center justify-between text-sm">
        <span class="text-slate-600">Vaste lasten</span>
        <span class="tabular-nums"><span class="font-semibold text-slate-900">${formatMoney(s.fixed)}</span> <span class="text-xs text-slate-400">${formatPct(s.fixed / s.expense * 100)} van je uitgaven</span></span>
      </div>
      <div class="h-2 bg-white rounded-full overflow-hidden mt-2 flex">
        <div class="h-full bg-brand-500" style="width:${(s.fixed / s.expense * 100).toFixed(1)}%"></div>
        <div class="h-full bg-rose-300" style="width:${(100 - s.fixed / s.expense * 100).toFixed(1)}%"></div>
      </div>
      <div class="flex gap-4 mt-1.5 text-[11px] text-slate-400">
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm bg-brand-500"></span>Vast</span>
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-sm bg-rose-300"></span>Variabel ${formatMoney(s.expense - s.fixed)}</span>
      </div>
    </div>` : ''}
    <p class="text-[11px] text-slate-400 mt-2">${prevPeriod ? `Vergeleken met ${formatRange(prevPeriod.start, prevPeriod.end)}.` : 'Nog geen vorige periode om mee te vergelijken.'}${period.isCurrent ? ' De huidige periode loopt nog.' : ''}</p>`;

  // --- Categorieën (donut + balken) ---
  const cats = Object.entries(s.categories).sort((a, b) => b[1] - a[1]);
  let catHtml = emptyNote('Geen uitgaven in deze periode.');
  if (cats.length && s.expense > 0) {
    let offset = 0;
    const segs = cats.map(([c, v], i) => {
      const pct = v / s.expense * 100;
      const seg = `<circle cx="21" cy="21" r="15.915" fill="none" stroke="${CHART_COLORS[i % CHART_COLORS.length]}" stroke-width="6"
        stroke-dasharray="${pct.toFixed(3)} ${(100 - pct).toFixed(3)}" stroke-dashoffset="${(25 - offset).toFixed(3)}"></circle>`;
      offset += pct;
      return seg;
    }).join('');
    catHtml = `
      <div class="flex items-center gap-4">
        <div class="relative w-32 h-32 shrink-0">
          <svg viewBox="0 0 42 42" class="w-full h-full"><circle cx="21" cy="21" r="15.915" fill="none" stroke="#f1f5f9" stroke-width="6"></circle>${segs}</svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <p class="text-[10px] text-slate-400">Totaal</p>
            <p class="text-sm font-bold text-slate-900 tabular-nums">${formatMoney(s.expense)}</p>
          </div>
        </div>
        <div class="flex-1 min-w-0 space-y-1.5">
          ${cats.slice(0, 5).map(([c, v], i) => `
            <div class="flex items-center gap-2 text-xs">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>
              <span class="flex-1 min-w-0 truncate text-slate-600">${escapeHtml(c)}</span>
              <span class="font-semibold text-slate-900 tabular-nums">${formatPct(v / s.expense * 100)}</span>
            </div>`).join('')}
          ${cats.length > 5 ? `<p class="text-[11px] text-slate-400">+ ${cats.length - 5} meer</p>` : ''}
        </div>
      </div>
      <div class="space-y-2.5 mt-4">
        ${cats.map(([c, v], i) => `
          <div>
            <div class="flex justify-between text-sm">
              <span class="text-slate-700 truncate">${escapeHtml(c)}</span>
              <span class="tabular-nums"><span class="font-semibold text-slate-900">${formatMoney(v)}</span> <span class="text-xs text-slate-400">${formatPct(v / s.expense * 100)}</span></span>
            </div>
            <div class="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1"><div class="h-full rounded-full" style="width:${(v / cats[0][1] * 100).toFixed(1)}%; background:${CHART_COLORS[i % CHART_COLORS.length]}"></div></div>
          </div>`).join('')}
      </div>`;
  }

  // --- Trend: laatste 6 periodes ---
  const trendPeriods = periods.slice(0, 6).reverse();
  const trendStats = trendPeriods.map(p => ({ p, st: periodStats(p) }));
  const maxTrend = Math.max(1, ...trendStats.map(x => Math.max(x.st.income, x.st.expense, x.st.saved)));
  const anySaved = trendStats.some(x => x.st.saved !== 0);
  const W = 320, H = 150, top = 14, base = 122, n = trendStats.length, slot = W / Math.max(n, 1), bw = Math.min(anySaved ? 13 : 18, slot / (anySaved ? 4.4 : 3.2));
  const fmtShort = v => v >= 1000 ? `€${(v / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}k` : `€${Math.round(v)}`;
  const trendSvg = `
    <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img" aria-label="Inkomsten en uitgaven per periode">
      ${[0.5, 1].map(f => `<line x1="0" x2="${W}" y1="${base - (base - top) * f}" y2="${base - (base - top) * f}" stroke="#f1f5f9" stroke-width="1"/>`).join('')}
      <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="#e2e8f0" stroke-width="1"/>
      ${trendStats.map(({ p, st }, i) => {
        const cx = slot * i + slot / 2;
        const hi = (base - top) * st.income / maxTrend, he = (base - top) * st.expense / maxTrend;
        const sel = p.key === period.key;
        return `
          ${sel ? `<rect x="${cx - slot / 2 + 3}" y="2" width="${slot - 6}" height="${H - 4}" rx="10" fill="#eef2ff"/>` : ''}
          ${anySaved ? (() => { const hs = (base - top) * Math.max(0, st.saved) / maxTrend; return `
          <rect x="${cx - bw * 1.5 - 2}" y="${base - hi}" width="${bw}" height="${Math.max(hi, 0.5)}" rx="3" fill="#10b981"/>
          <rect x="${cx - bw / 2}" y="${base - he}" width="${bw}" height="${Math.max(he, 0.5)}" rx="3" fill="#f43f5e"/>
          <rect class="trend-saved" x="${cx + bw / 2 + 2}" y="${base - hs}" width="${bw}" height="${Math.max(hs, 0.5)}" rx="3" fill="#14b8a6"/>`; })() : `
          <rect x="${cx - bw - 1.5}" y="${base - hi}" width="${bw}" height="${Math.max(hi, 0.5)}" rx="3" fill="#10b981"/>
          <rect x="${cx + 1.5}" y="${base - he}" width="${bw}" height="${Math.max(he, 0.5)}" rx="3" fill="#f43f5e"/>`}
          <text x="${cx}" y="${base + 13}" text-anchor="middle" font-size="10" fill="${sel ? '#4338ca' : '#94a3b8'}" font-weight="${sel ? 700 : 500}">${p.isCurrent ? 'nu' : ymdToDate(p.start).toLocaleDateString('nl-NL', { month: 'short' }).replace('.', '')}</text>
          <text x="${cx}" y="${base + 24}" text-anchor="middle" font-size="8.5" fill="${st.net >= 0 ? '#059669' : '#e11d48'}">${st.net >= 0 ? '+' : '−'}${fmtShort(Math.abs(st.net))}</text>`;
      }).join('')}
      <text x="2" y="${top - 4}" font-size="9" fill="#94a3b8">${fmtShort(maxTrend)}</text>
    </svg>
    <div class="flex gap-4 justify-center mt-1 text-xs text-slate-500">
      <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm bg-emerald-500"></span>Inkomsten</span>
      <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm bg-rose-500"></span>Uitgaven</span>
      ${anySaved ? '<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:#14b8a6"></span>Gespaard</span>' : ''}
    </div>`;

  // --- Uitgaven door de periode (cumulatief) ---
  let lineHtml = emptyNote('Nog geen uitgaven om te tonen.');
  if (s.expense > 0) {
    const totalDays = daysBetween(period.start, period.nominalEnd), shownDays = daysBetween(period.start, period.end);
    const perDay = new Array(totalDays).fill(0);
    s.expenses.forEach(t => {
      const d = daysBetween(period.start, txYmd(t)) - 1;
      if (d >= 0 && d < totalDays) perDay[d] += t.amount;
    });
    let cum = 0;
    const cumul = perDay.slice(0, shownDays).map(v => (cum += v));
    const maxY = Math.max(cum, s.income || 0) * 1.08 || 1;
    const LW = 320, LH = 130, lt = 8, lb = 112;
    const x = i => totalDays <= 1 ? 0 : i / (totalDays - 1) * LW;
    const y = v => lb - (lb - lt) * v / maxY;
    const pts = cumul.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const area = `M0,${lb} L${pts.join(' L')} L${x(cumul.length - 1).toFixed(1)},${lb} Z`;
    const mid = addDaysYmd(period.start, Math.floor((totalDays - 1) / 2));
    lineHtml = `
      <svg viewBox="0 0 ${LW} ${LH}" class="w-full h-auto" role="img" aria-label="Cumulatieve uitgaven">
        <defs><linearGradient id="cumFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#6366f1" stop-opacity="0.25"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs>
        <line x1="0" x2="${LW}" y1="${lb}" y2="${lb}" stroke="#e2e8f0"/>
        ${s.income > 0 ? `<line x1="0" x2="${LW}" y1="${y(s.income)}" y2="${y(s.income)}" stroke="#10b981" stroke-dasharray="4 4" stroke-width="1.2"/>
          <text x="${LW - 2}" y="${y(s.income) - 4}" text-anchor="end" font-size="9" fill="#059669">Inkomsten ${fmtShort(s.income)}</text>` : ''}
        <path d="${area}" fill="url(#cumFill)"/>
        <polyline points="${pts.join(' ')}" fill="none" stroke="#6366f1" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(cumul.length - 1)}" cy="${y(cum)}" r="3.5" fill="#6366f1" stroke="white" stroke-width="1.5"/>
        <text x="${Math.min(x(cumul.length - 1), LW - 40)}" y="${y(cum) - 8}" font-size="9.5" font-weight="700" fill="#4338ca">${fmtShort(cum)}</text>
        <text x="0" y="${LH - 4}" font-size="9" fill="#94a3b8">${formatShortDate(period.start)}</text>
        <text x="${LW / 2}" y="${LH - 4}" text-anchor="middle" font-size="9" fill="#94a3b8">${formatShortDate(mid)}</text>
        <text x="${LW}" y="${LH - 4}" text-anchor="end" font-size="9" fill="#94a3b8">${formatShortDate(period.nominalEnd)}</text>
      </svg>`;
  }

  // --- Potjes ---
  const pots = period.pots.map(p => ({ ...p, spent: s.spentByPot[p.id] || 0 }));
  const potsHtml = !pots.length ? emptyNote('Geen potjes in deze periode.') : `<div class="space-y-3.5">${pots.map(p => {
    const budget = p.budget, spent = p.spent;
    const pct = budget ? Math.min(100, spent / budget * 100) : 0;
    const over = budget != null && spent > budget;
    return `
      <div>
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium text-slate-800 truncate">${escapeHtml(p.emoji || '💰')} ${escapeHtml(p.name)}</span>
          <span class="text-xs text-slate-400 tabular-nums shrink-0">${budget == null ? 'budget onbekend' : `budget ${formatMoney(budget)}`}</span>
        </div>
        <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden mt-1.5">
          <div class="h-full rounded-full ${over ? 'bg-rose-500' : 'bg-gradient-to-r from-brand-500 to-brand-400'}" style="width:${budget ? pct.toFixed(1) : 0}%"></div>
        </div>
        <div class="flex justify-between text-xs mt-1 tabular-nums">
          <span class="text-slate-500">Uitgegeven ${formatMoney(spent)}${budget ? ` · ${formatPct(spent / budget * 100)}` : ''}</span>
          <span class="font-semibold text-brand-700">${p.leftover == null ? '' : `Over ${formatMoney(p.leftover)}`}</span>
        </div>
      </div>`;
  }).join('')}</div>`;

  // --- Spaardoelen (apart van potjes en uitgaven) ---
  const goalRows = (state.goals || []).map(g => ({ g, inPeriod: s.savedByGoal[g.id] || 0 }))
    .sort((a, b) => b.inPeriod - a.inPeriod);
  const goalsHtml = !goalRows.length ? emptyNote('Nog geen spaardoelen.') : `
    <div class="flex items-center justify-between text-sm goal-bg rounded-xl px-3.5 py-2.5 mb-3">
      <span class="goal-text font-medium">Totaal ${period.isCurrent ? 'deze periode' : 'in deze periode'}</span>
      <span class="goal-text font-bold tabular-nums">${s.saved < 0 ? '−' : '+'}${formatMoney(Math.abs(s.saved))}</span>
    </div>
    <div class="space-y-3.5">${goalRows.map(({ g, inPeriod }) => {
      const pct = g.target > 0 ? Math.min(100, g.current / g.target * 100) : 0;
      return `
      <div>
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium text-slate-800 truncate">🎯 ${escapeHtml(g.name)}</span>
          <span class="text-xs tabular-nums shrink-0 ${inPeriod > 0 ? 'goal-text font-semibold' : inPeriod < 0 ? 'text-rose-600 font-semibold' : 'text-slate-400'}">${inPeriod > 0 ? '+' + formatMoney(inPeriod) : inPeriod < 0 ? '−' + formatMoney(-inPeriod) + ' opgenomen' : 'niets gestort'}</span>
        </div>
        <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden mt-1.5"><div class="h-full rounded-full goal-bar" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="flex justify-between text-xs mt-1 tabular-nums">
          <span class="text-slate-500">Nu ${formatMoney(g.current)} van ${formatMoney(g.target)}</span>
          <span class="text-slate-400">${formatPct(pct)}</span>
        </div>
      </div>`; }).join('')}</div>`;

  // --- Top 5 ---
  const top5 = [...s.expenses].sort((a, b) => b.amount - a.amount).slice(0, 5);
  const topHtml = !top5.length ? emptyNote('Geen uitgaven in deze periode.') : `<div class="space-y-1.5">${top5.map((t, i) => `
    <div class="flex items-center gap-3 bg-slate-50 rounded-xl px-3 py-2.5">
      <span class="w-6 h-6 rounded-full bg-white text-xs font-bold text-slate-500 flex items-center justify-center shrink-0">${i + 1}</span>
      <div class="flex-1 min-w-0">
        <p class="font-medium text-slate-800 truncate text-sm">${escapeHtml(t.description || t.category)}</p>
        <p class="text-xs text-slate-400">${escapeHtml(t.category)} · ${formatShortDate(txYmd(t))}</p>
      </div>
      <p class="font-semibold text-sm tabular-nums text-rose-600">−${formatMoney(t.amount)}</p>
    </div>`).join('')}</div>`;

  el.innerHTML = [
    card('Kerncijfers', kpis),
    card('Uitgaven per categorie', catHtml),
    card('Uitgaven door de periode', lineHtml, '<span class="text-[11px] text-slate-400">cumulatief</span>'),
    card('Trend', trendStats.length > 1 || s.income || s.expense ? trendSvg : emptyNote('Nog geen gegevens.'), `<span class="text-[11px] text-slate-400">laatste ${trendStats.length} ${trendStats.length === 1 ? 'periode' : 'periodes'}</span>`),
    card('🎯 Spaardoelen', goalsHtml, '<span class="text-[11px] text-slate-400">geen uitgaven</span>'),
    card('🏺 Potjes', potsHtml),
    card('Top 5 grootste uitgaven', topHtml),
  ].join('');
}

// ==================== GESCHIEDENIS ====================
// potsAtClose: [{id,name,emoji,budget,balance}] of null als onbekend (migratie).
function makePeriodSnapshot(start, end, potsAtClose) {
  const txs = transactionsBetween(start, end);
  const r = x => Math.round(x * 100) / 100;
  const income = r(txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0));
  const expense = r(txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0));
  const categories = {};
  txs.filter(t => t.type === 'expense').forEach(t => { categories[t.category] = r((categories[t.category] || 0) + t.amount); });
  const spentByPot = {};
  txs.filter(t => t.type === 'expense' && t.potId).forEach(t => { spentByPot[t.potId] = r((spentByPot[t.potId] || 0) + t.amount); });
  let pots;
  if (potsAtClose) {
    pots = potsAtClose.map(p => ({ id: p.id, name: p.name, emoji: p.emoji, budget: p.budget ?? null, spent: spentByPot[p.id] || 0, leftover: r(p.balance) }));
  } else {
    pots = Object.keys(spentByPot).map(id => {
      const p = state.pots.find(x => x.id === id);
      return { id, name: p ? p.name : 'Verwijderd potje', emoji: p ? p.emoji : '💰', budget: null, spent: spentByPot[id], leftover: null };
    });
  }
  return { id: uid(), start, end, income, expense, net: r(income - expense), categories, pots, count: txs.length };
}

function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('no-history');
  const items = [...state.history].sort((a, b) => b.start.localeCompare(a.start));
  empty.classList.toggle('hidden', items.length > 0);
  list.innerHTML = items.map((h, i) => `
    <div onclick="openHistoryDetail('${h.id}')" class="item-enter pressable cursor-pointer bg-white rounded-2xl p-4 shadow-card border border-slate-100/60" style="animation-delay: ${i * 40}ms">
      <div class="flex items-center justify-between">
        <p class="font-semibold text-slate-900">${formatRange(h.start, h.end)}</p>
        <p class="font-bold tabular-nums ${h.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${h.net >= 0 ? '+' : '−'}${formatMoney(Math.abs(h.net))}</p>
      </div>
      <div class="flex gap-4 mt-1.5 text-xs text-slate-400 tabular-nums">
        <span>In ${formatMoney(h.income)}</span>
        <span>Uit ${formatMoney(h.expense)}</span>
        <span>${h.count ?? 0} ${(h.count ?? 0) === 1 ? 'transactie' : 'transacties'}</span>
      </div>
    </div>
  `).join('');
}

function openHistoryDetail(id) {
  const h = state.history.find(x => x.id === id);
  if (!h) return;
  document.getElementById('history-detail-title').textContent = formatRange(h.start, h.end);
  const cats = Object.entries(h.categories || {}).sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 0;
  const txs = transactionsBetween(h.start, h.end);
  const stat = (label, value, cls) => `
    <div class="bg-slate-50 rounded-2xl p-3">
      <p class="text-xs text-slate-400">${label}</p>
      <p class="font-bold text-[15px] tabular-nums mt-0.5 ${cls}">${value}</p>
    </div>`;
  const section = title => `<h4 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mt-5 mb-2">${title}</h4>`;
  document.getElementById('history-detail-body').innerHTML = `
    <div class="grid grid-cols-3 gap-2">
      ${stat('Inkomsten', formatMoney(h.income), 'text-emerald-600')}
      ${stat('Uitgaven', formatMoney(h.expense), 'text-rose-600')}
      ${stat('Netto', (h.net >= 0 ? '+' : '−') + formatMoney(Math.abs(h.net)), h.net >= 0 ? 'text-slate-900' : 'text-rose-600')}
    </div>
    ${cats.length ? section('Uitgaven per categorie') + `<div class="space-y-2.5">${cats.map(([c, v]) => `
      <div>
        <div class="flex justify-between text-sm"><span class="text-slate-700">${escapeHtml(c)}</span><span class="font-semibold tabular-nums text-slate-900">${formatMoney(v)}</span></div>
        <div class="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1"><div class="h-full bg-gradient-to-r from-brand-500 to-brand-400 rounded-full" style="width: ${maxCat ? Math.round(v / maxCat * 100) : 0}%"></div></div>
      </div>`).join('')}</div>` : ''}
    ${(h.pots || []).length ? section('Potjes') + `<div class="space-y-1.5">${h.pots.map(p => `
      <div class="flex items-center gap-3 bg-slate-50 rounded-xl px-3.5 py-2.5">
        <span class="text-lg">${escapeHtml(p.emoji || '💰')}</span>
        <div class="flex-1 min-w-0">
          <p class="font-medium text-slate-800 truncate text-sm">${escapeHtml(p.name)}</p>
          <p class="text-xs text-slate-400 tabular-nums">Budget ${p.budget == null ? 'onbekend' : formatMoney(p.budget)} · uitgegeven ${formatMoney(p.spent)}</p>
        </div>
        <div class="text-right">
          <p class="text-xs text-slate-400">Over</p>
          <p class="font-semibold text-sm tabular-nums text-brand-700">${p.leftover == null ? '–' : formatMoney(p.leftover)}</p>
        </div>
      </div>`).join('')}</div>` : ''}
    ${section(`Transacties (${txs.length})`)}
    <div class="space-y-1.5">${txs.length ? txs.map(t => `
      <div class="flex items-center gap-3 bg-slate-50 rounded-xl px-3.5 py-2.5">
        <div class="flex-1 min-w-0">
          <p class="font-medium text-slate-800 truncate text-sm">${escapeHtml(t.description || t.category)}${t.recurringId ? VAST_BADGE : ''}</p>
          <p class="text-xs text-slate-400">${escapeHtml(t.category)} · ${formatShortDate(txYmd(t))}</p>
        </div>
        <p class="font-semibold text-sm tabular-nums ${t.type === 'expense' ? 'text-rose-600' : 'text-emerald-600'}">${t.type === 'expense' ? '−' : '+'}${formatMoney(t.amount)}</p>
      </div>`).join('') : '<p class="text-sm text-slate-400 text-center py-4">Geen transacties in deze periode.</p>'}</div>
  `;
  openModal('history-detail');
}

// ==================== PERIODE ====================
function renderPeriodBanner() {
  const banner = document.getElementById('period-banner');
  const start = getCurrentPeriodStart();
  const dismissed = sessionStorage.getItem('periodBannerDismissed') === start;
  banner.classList.toggle('hidden', !isNewPeriodDue() || dismissed);
  document.getElementById('period-banner-date').textContent = `Je periode begon op ${formatLongDate(start)}`;
}

function dismissPeriodBanner(e) {
  if (e) e.stopPropagation();
  sessionStorage.setItem('periodBannerDismissed', getCurrentPeriodStart());
  renderPeriodBanner();
}

function openNewPeriod() {
  const list = document.getElementById('new-period-list');
  const empty = document.getElementById('new-period-empty');
  document.getElementById('new-period-subtitle').textContent = isNewPeriodDue()
    ? `Vanaf ${formatLongDate(getCurrentPeriodStart())}. Elk potje wordt op het nieuwe budget gezet; wat over is komt vrij.`
    : `De huidige periode (sinds ${formatLongDate(state.lastPeriodStart)}) loopt nog. Je zet de potjes opnieuw op hun budget; er komt geen nieuwe periode in de geschiedenis.`;
  empty.classList.toggle('hidden', state.pots.length > 0);
  list.innerHTML = state.pots.map(p => `
    <div class="flex items-center gap-3 bg-slate-50 rounded-2xl px-3.5 py-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 flex items-center justify-center text-xl shrink-0">${escapeHtml(p.emoji || '💰')}</div>
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-slate-900 truncate text-[15px]">${escapeHtml(p.name)}</p>
        <p class="text-xs text-slate-400 mt-0.5 tabular-nums">Nu: ${formatMoney(p.balance)}</p>
      </div>
      <div class="relative w-32 shrink-0">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">€</span>
        <input type="number" step="0.01" min="0" inputmode="decimal" data-pot-id="${p.id}" value="${Math.round((p.budget ?? p.balance) * 100) / 100}"
               class="w-full pl-8 pr-3 py-2.5 bg-white border border-slate-200 rounded-xl text-right font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500/40">
      </div>
    </div>
  `).join('');
  closeModal();
  setTimeout(() => openModal('new-period'), 200);
}

function startNewPeriod(e) {
  e.preventDefault();
  const inputs = [...document.querySelectorAll('#new-period-list input[data-pot-id]')];
  for (const input of inputs) {
    const value = parseFloat(String(input.value).replace(',', '.'));
    if (input.value === '' || isNaN(value) || value < 0) {
      alert('Vul voor elk potje een geldig bedrag in (0 of meer).');
      input.focus();
      return;
    }
  }
  const newStart = getCurrentPeriodStart();
  const isNewPeriod = !state.lastPeriodStart || newStart > state.lastPeriodStart;
  if (isNewPeriod && state.lastPeriodStart) {
    // Sluit de vorige periode af (vóórdat de potjes opnieuw worden gevuld).
    state.history.unshift(makePeriodSnapshot(state.lastPeriodStart, addDaysYmd(newStart, -1),
      state.pots.map(p => ({ ...p }))));
  }
  inputs.forEach(input => {
    const pot = state.pots.find(p => p.id === input.dataset.potId);
    if (!pot) return;
    const value = Math.round(parseFloat(String(input.value).replace(',', '.')) * 100) / 100;
    pot.budget = value;
    pot.balance = value;
  });
  state.lastPeriodStart = newStart;
  goalResetToast(runGoalResets()); // meestal al gebeurd op de betaaldag; hooguit één keer per periode
  sessionStorage.removeItem('periodBannerDismissed');
  saveState();
  render();
  closeModal();
  showToast(isNewPeriod ? 'Nieuwe periode gestart ✓' : 'Potjes opnieuw ingesteld ✓');
}

function updatePeriodStartDay(input) {
  const day = parseInt(input.value, 10);
  if (isNaN(day) || day < 1 || day > 28) {
    input.value = state.settings.periodStartDay;
    return alert('Kies een dag tussen 1 en 28.');
  }
  if (day === state.settings.periodStartDay) return;
  state.settings.periodStartDay = day;
  // De lopende periode begint NIET opnieuw: hij loopt nu tot de dag vóór de nieuwe startdag.
  // Vaste lasten worden per betaling (maand) bijgehouden, dus niets wordt opnieuw geboekt.
  runAutoBooking();
  saveState();
  render();
  renderPeriodSettings();
  showToast(isNewPeriodDue()
    ? `Startdag ${day}: je kunt een nieuwe periode starten`
    : `Startdag ${day} ✓ Deze periode loopt t/m ${formatLongDate(getPeriodEnd(state.lastPeriodStart))}`);
}

function renderPeriodSettings() {
  document.getElementById('period-start-day').value = state.settings.periodStartDay;
  document.getElementById('period-current-info').textContent = state.lastPeriodStart
    ? (isNewPeriodDue()
      ? `Laatst gestarte periode: ${formatLongDate(state.lastPeriodStart)}`
      : `Huidige periode: ${formatRange(state.lastPeriodStart, getPeriodEnd(state.lastPeriodStart))}`)
    : 'Nog geen periode gestart';
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('open'), 2500);
}

function renderTransactions() {
  const list = document.getElementById('transactions-list');
  const empty = document.getElementById('no-transactions');
  const query = getSearchQuery();
  const sorted = query ? searchTransactions(query) : transactionsBetween(state.lastPeriodStart, null);
  const info = document.getElementById('search-info');
  if (info) {
    info.classList.toggle('hidden', !query);
    document.getElementById('search-count').textContent = query ? (sorted.length === 1 ? '1 resultaat' : `${sorted.length} resultaten`) : '';
    const totEl = document.getElementById('search-total');
    if (query && sorted.length) {
      const inc = sorted.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
      const out = sorted.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
      const net = inc - out;
      const sub = inc > 0 && out > 0 ? `<span class="sub">in ${formatMoney(inc)} / uit ${formatMoney(out)}</span>` : '';
      totEl.innerHTML = sub + `<span class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${formatMoney(Math.abs(net))}</span>`;
    } else totEl.innerHTML = '';
  }
  document.body.classList.toggle('searching', !!query);
  {
  }
  const nominalEnd = getPeriodEnd(state.lastPeriodStart);
  document.getElementById('period-label').textContent = isNewPeriodDue()
    ? `${formatShortDate(state.lastPeriodStart)} – vandaag`
    : formatRange(state.lastPeriodStart, nominalEnd);
  document.getElementById('no-transactions-text').innerHTML = state.transactions.length
    ? 'Nog geen transacties in deze periode.<br>Eerdere periodes vind je bij Geschiedenis.'
    : 'Nog geen transacties.<br>Voeg je eerste uitgave of inkomst toe!';

  if (query) {
    document.getElementById('no-transactions-text').innerHTML = `Niets gevonden voor “${escapeHtml(query)}”.`;
  }
  if (sorted.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const shown = query ? sorted.slice(0, 200) : sorted;
  list.innerHTML = shown.map((t, i) => {
    const isExpense = t.type === 'expense';
    const pot = t.potId ? state.pots.find(p => p.id === t.potId) : null;
    return `
      <div onclick="openEditTransaction('${t.id}')" class="item-enter pressable cursor-pointer bg-white rounded-2xl p-3.5 flex items-center gap-3 shadow-card border border-slate-100/60" style="animation-delay: ${Math.min(i, 15) * 30}ms">
        <div class="w-11 h-11 rounded-xl flex items-center justify-center text-lg shrink-0 ${isExpense ? 'bg-rose-50' : 'bg-emerald-50'}">
          ${isExpense ? '📉' : '📈'}
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-slate-900 truncate text-[15px]">${escapeHtml(t.description || t.category)}${t.recurringId ? VAST_BADGE : ''}</p>
          <p class="text-xs text-slate-400 mt-0.5">${escapeHtml(t.category)}${pot ? ' · ' + escapeHtml(pot.emoji || '💰') + ' ' + escapeHtml(pot.name) : ''} · ${query ? formatShortDate(txYmd(t), true) : formatDate(t.date)}</p>
        </div>
        <p class="font-bold text-[15px] tabular-nums ${isExpense ? 'text-rose-600' : 'text-emerald-600'}">
          ${isExpense ? '−' : '+'}${formatMoney(t.amount)}
        </p>
      </div>
    `;
  }).join('');
}

function renderPots() {
  const list = document.getElementById('pots-list');
  const empty = document.getElementById('no-pots');

  if (state.pots.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = state.pots.map((p, i) => `
    <div onclick="openPotAction('${p.id}')" class="item-enter pressable bg-white rounded-2xl p-4 shadow-card border border-slate-100/60 flex items-center gap-3.5 cursor-pointer" style="animation-delay: ${i * 40}ms">
      <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-50 to-brand-100 flex items-center justify-center text-2xl shrink-0">
        ${escapeHtml(p.emoji || '💰')}
      </div>
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-slate-900">${escapeHtml(p.name)}</p>
        <p class="text-xs mt-0.5 ${p.balance < 0 ? 'text-rose-600 font-semibold' : 'text-slate-400'}">${p.balance < 0 ? 'In de min' : 'Potje'}</p>
      </div>
      <p class="font-bold text-lg ${p.balance < 0 ? 'text-rose-600' : 'text-brand-700'} tabular-nums">${formatMoney(p.balance)}</p>
    </div>
  `).join('');
}

function renderGoals() {
  const list = document.getElementById('goals-list');
  const empty = document.getElementById('no-goals');

  if (state.goals.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const periodTotal = getGoalTransfersThisPeriod();
  const summary = `
      <div id="goals-period-summary" class="item-enter goal-bg rounded-2xl px-4 py-3 flex items-center justify-between text-sm">
        <span class="goal-text">🎯 Deze periode naar spaardoelen<span class="block text-xs goal-text-soft">Gaat van je beschikbaar saldo af · staat los van je potjes</span></span>
        <span class="font-semibold tabular-nums goal-text whitespace-nowrap shrink-0 ml-1">${periodTotal < 0 ? '+' + formatMoney(-periodTotal) : '−' + formatMoney(periodTotal)}</span>
      </div>`;
  list.innerHTML = summary + state.goals.map((g, i) => {
    const pct = Math.min(100, Math.round((g.current / g.target) * 100));
    return `
      <div class="item-enter bg-white rounded-2xl p-4 shadow-card border border-slate-100/60" style="animation-delay: ${i * 40}ms">
        <div class="flex items-center justify-between mb-3 gap-2">
          <div class="min-w-0">
            <p class="font-semibold text-slate-900 truncate">${escapeHtml(g.name)}</p>
            ${goalResetsEnabled(g) ? `<span class="goal-reset-badge goal-text goal-bg inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full mt-1">🔁 reset elke periode</span>` : ''}
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button onclick="openEditGoal('${g.id}')" aria-label="Spaardoel bewerken" title="Bewerken" class="goal-edit-btn text-sm text-slate-400 bg-slate-100 w-8 h-8 rounded-full flex items-center justify-center pressable">✎</button>
            ${g.current > 0 ? `<button onclick="withdrawFromGoal('${g.id}')" class="text-xs font-semibold text-slate-500 bg-slate-100 px-3 py-1.5 rounded-full pressable">− Geld</button>` : ''}
            <button onclick="addToGoal('${g.id}')" class="text-xs font-semibold goal-text goal-bg px-3 py-1.5 rounded-full pressable">+ Geld</button>
          </div>
        </div>
        <div class="flex justify-between text-sm mb-1.5">
          <span class="font-medium text-slate-700 tabular-nums">${formatMoney(g.current)}</span>
          <span class="text-slate-400 tabular-nums">${formatMoney(g.target)}</span>
        </div>
        <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden">
          <div class="progress-bar h-full goal-bar rounded-full" style="width: ${pct}%"></div>
        </div>
        <p class="text-xs mt-2 ${pct >= 100 ? 'text-emerald-600 font-semibold' : 'text-slate-400'}">${pct >= 100 ? '🎉 Doel bereikt!' : pct + '% bereikt'}</p>
        ${goalResetsEnabled(g) && g.lastResetPeriod === getCurrentPeriodStart() && g.lastResetAmount > 0 ? `<p class="goal-reset-note text-[11px] text-slate-400 mt-1">Op ${formatLongDate(g.lastResetPeriod)} teruggezet (er stond ${formatMoney(g.lastResetAmount)})</p>` : ''}
      </div>
    `;
  }).join('');
}

function populateCategorySelects() {
  const expSelect = document.getElementById('expense-category');
  const incSelect = document.getElementById('income-category');
  expSelect.innerHTML = state.categories.expense.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  incSelect.innerHTML = state.categories.income.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

function populatePotSelect() {
  const select = document.getElementById('expense-pot');
  const current = select.value;
  select.innerHTML = '<option value="">— Geen potje —</option>' +
    state.pots.map(p => `<option value="${p.id}">${escapeHtml(p.emoji || '💰')} ${escapeHtml(p.name)} (${formatMoney(p.balance)})</option>`).join('');
  if (current) select.value = current;
}

// ==================== TABS ====================
function switchTab(tab) {
  if (tab === 'analysis') { renderAnalysis(); animateCharts(); }
  ['overview', 'pots', 'goals', 'history', 'analysis'].forEach(t => {
    const panel = document.getElementById(`panel-${t}`);
    const wasHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', t !== tab);
    if (t === tab && wasHidden) replayAnimation(panel, 'panel-enter');
    const btn = document.getElementById(`tab-${t}`);
    if (!btn) return;
    if (t === tab) {
      btn.classList.add('tab-active');
      btn.classList.remove('text-slate-500');
    } else {
      btn.classList.remove('tab-active');
      btn.classList.add('text-slate-500');
    }
  });
}

// ==================== MODALS ====================
function openModal(name) {
  const backdrop = document.getElementById('modal-backdrop');
  const modal = document.getElementById(`modal-${name}`);
  backdrop.classList.add('open');
  modal.scrollTop = 0;
  modal.querySelectorAll('*').forEach(el => { if (el.scrollTop) el.scrollTop = 0; });
  modal.classList.add('open');
  haptic(6);
  if (name === 'categories') renderCategoriesList();
  if (name === 'settings') renderPeriodSettings();
  if (modal.hasAttribute('data-no-autofocus')) return;
  setTimeout(() => {
    const input = modal.querySelector('input:not([type=hidden])');
    if (input) input.focus();
  }, 280);
}

// Sluiten na opslaan/bewerken: terug naar boven. Annuleren (✕ / achtergrond): positie behouden.
function cancelModal() { closeModal({ keepScroll: true }); }

function closeModal(opts) {
  document.getElementById('modal-backdrop').classList.remove('open');
  document.querySelectorAll('.modal').forEach(m => {
    m.classList.remove('open');
    m.querySelectorAll('.overflow-y-auto, .overflow-auto').forEach(el => { el.scrollTop = 0; });
  });
  currentPotId = null;
  if (!(opts && opts.keepScroll)) scrollToTop(true);
}

function scrollToTop(smooth) {
  const go = () => { try {
    const behavior = smooth && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'smooth' : 'auto';
    try { window.scrollTo({ top: 0, left: 0, behavior }); } catch (e) { window.scrollTo(0, 0); }
    const se = document.scrollingElement || document.documentElement;
    if (!smooth) { se.scrollTop = 0; document.body.scrollTop = 0; }
  } catch (e) { /* geen scroll-ondersteuning */ } };
  // Na de re-render (render() volgt vaak direct op closeModal) scrollen.
  const raf = window.requestAnimationFrame || (f => setTimeout(f, 16));
  raf(() => raf(go));
}

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.addEventListener('pageshow', () => scrollToTop(false));
window.addEventListener('load', () => scrollToTop(false));

// ==================== ACTIONS ====================
function addTransaction(e, type) {
  e.preventDefault();
  const form = e.target;
  const amount = parseFloat(form.amount.value);
  const description = form.description.value.trim();
  const category = form.category.value;
  const potId = form.potId ? form.potId.value || null : null;

  if (type === 'expense' && potId) {
    const pot = state.pots.find(p => p.id === potId);
    if (pot) pot.balance = Math.round((pot.balance - amount) * 100) / 100;
  }

  state.transactions.unshift({
    id: uid(),
    type,
    amount,
    description,
    category,
    potId,
    date: new Date().toISOString()
  });

  saveState();
  render();
  closeModal();
  form.reset();
  if (navigator.vibrate) navigator.vibrate(10);
}

function deleteTransaction(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`Transactie "${t.description || t.category}" (${formatMoney(t.amount)}) verwijderen?`)) return;
  if (t.type === 'expense' && t.potId) {
    const pot = state.pots.find(p => p.id === t.potId);
    if (pot) pot.balance = Math.round((pot.balance + t.amount) * 100) / 100;
  }
  state.transactions = state.transactions.filter(x => x.id !== id);
  saveState();
  render();
  closeModal();
}

// ==================== BEWERKEN ====================
let editingTransactionId = null;

function openEditTransaction(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  editingTransactionId = id;
  const form = document.getElementById('edit-transaction-form');
  const isExpense = t.type === 'expense';
  document.getElementById('edit-transaction-type').textContent = isExpense ? 'Uitgave' : 'Inkomst';
  form.amount.value = t.amount;
  form.description.value = t.description || '';
  // Categorieën van dit type; een inmiddels verwijderde categorie blijft kiesbaar voor deze transactie.
  const cats = [...state.categories[t.type]];
  if (t.category && !cats.includes(t.category)) cats.unshift(t.category);
  form.category.innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  form.category.value = t.category;
  // Datum alleen binnen de huidige periode (afgesloten periodes blijven ongewijzigd).
  const todayYmd = toYmd(new Date());
  form.date.min = state.lastPeriodStart;
  form.date.max = todayYmd > txYmd(t) ? todayYmd : txYmd(t);
  form.date.value = txYmd(t);
  document.getElementById('edit-date-hint').textContent = `Binnen de huidige periode (vanaf ${formatLongDate(state.lastPeriodStart)})`;
  // Potje (alleen bij uitgaven). Toon het saldo alsof deze uitgave er nog niet af is.
  document.getElementById('edit-pot-field').classList.toggle('hidden', !isExpense);
  document.getElementById('edit-make-recurring').classList.toggle('hidden', !isExpense || !!t.recurringId);
  form.potId.innerHTML = '<option value="">— Geen potje —</option>' + state.pots.map(p => {
    const avail = p.balance + (t.potId === p.id ? t.amount : 0);
    return `<option value="${p.id}">${escapeHtml(p.emoji || '💰')} ${escapeHtml(p.name)} (${formatMoney(avail)})</option>`;
  }).join('');
  form.potId.value = isExpense && t.potId && state.pots.some(p => p.id === t.potId) ? t.potId : '';
  openModal('edit-transaction');
}

function saveEditTransaction(e) {
  e.preventDefault();
  const t = state.transactions.find(x => x.id === editingTransactionId);
  if (!t) return closeModal();
  const form = e.target;
  const amount = Math.round(parseFloat(String(form.amount.value).replace(',', '.')) * 100) / 100;
  if (isNaN(amount) || amount <= 0) return alert('Ongeldig bedrag');
  const dateYmd = form.date.value;
  if (!dateYmd || dateYmd < state.lastPeriodStart || dateYmd > form.date.max) {
    return alert(`Kies een datum binnen de huidige periode (vanaf ${formatLongDate(state.lastPeriodStart)} t/m vandaag).`);
  }
  const newPotId = t.type === 'expense' ? (form.potId.value || null) : null;

  // Controleer eerst of het (nieuwe) potje genoeg heeft, met de oude uitgave teruggezet.
  const oldPot = t.type === 'expense' && t.potId ? state.pots.find(p => p.id === t.potId) : null;
  const newPot = newPotId ? state.pots.find(p => p.id === newPotId) : null;
  if (oldPot) oldPot.balance = Math.round((oldPot.balance + t.amount) * 100) / 100;
  if (newPot) newPot.balance = Math.round((newPot.balance - amount) * 100) / 100;

  t.amount = amount;
  t.description = form.description.value.trim();
  t.category = form.category.value;
  t.potId = newPotId;
  if (dateYmd !== txYmd(t)) {
    const [y, m, d] = dateYmd.split('-').map(Number);
    const old = new Date(t.date);
    t.date = new Date(y, m - 1, d, old.getHours(), old.getMinutes(), old.getSeconds()).toISOString();
  }
  saveState();
  render();
  closeModal();
  showToast('Transactie opgeslagen ✓');
}

function deleteEditingTransaction() {
  if (editingTransactionId) deleteTransaction(editingTransactionId);
}

function addPot(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  const amount = parseFloat(form.amount.value) || 0;
  const emoji = form.emoji.value.trim() || '💰';
  const budgetValue = parseFloat(form.budget.value);
  const budget = isNaN(budgetValue) || budgetValue < 0 ? amount : Math.round(budgetValue * 100) / 100;

  state.pots.push({ id: uid(), name, balance: amount, budget, emoji });
  saveState();
  render();
  closeModal();
  form.reset();
  switchTab('pots');
}

function addGoal(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  const target = parseFloat(form.target.value);
  const current = parseFloat(form.current.value) || 0;
  const goal = { id: uid(), name, target, current };
  if (form.resetEachPeriod && form.resetEachPeriod.checked) {
    goal.resetEachPeriod = true;
    goal.lastResetPeriod = getCurrentPeriodStart(); // eerste reset op de volgende betaaldag
  }

  state.goals.push(goal);
  saveState();
  render();
  closeModal();
  form.reset();
  switchTab('goals');
}

// Spaardoel bewerken: naam, doelbedrag en 'Elke periode resetten'. Het gespaarde bedrag verander je met + / − Geld.
let editingGoalId = null;
function openEditGoal(id) {
  const goal = state.goals.find(g => g.id === id);
  if (!goal) return;
  editingGoalId = id;
  const form = document.getElementById('edit-goal-form');
  form.name.value = goal.name;
  form.target.value = goal.target;
  form.resetEachPeriod.checked = goalResetsEnabled(goal);
  openModal('edit-goal');
}

function setGoalResetEachPeriod(goal, on) {
  if (on && !goalResetsEnabled(goal)) {
    goal.resetEachPeriod = true;
    goal.lastResetPeriod = getCurrentPeriodStart(); // niet meteen resetten, pas op de volgende betaaldag
  } else if (!on && goalResetsEnabled(goal)) {
    goal.resetEachPeriod = false;
  }
}

function saveGoalEdit(e) {
  e.preventDefault();
  const form = e.target;
  const goal = state.goals.find(g => g.id === editingGoalId);
  if (!goal) { closeModal(); return; }
  const name = form.name.value.trim();
  const target = parseFloat(String(form.target.value).replace(',', '.'));
  if (!name) return alert('Vul een naam in.');
  if (isNaN(target) || target <= 0) return alert('Vul een geldig doelbedrag in.');
  const wasOn = goalResetsEnabled(goal);
  goal.name = name;
  goal.target = Math.round(target * 100) / 100;
  setGoalResetEachPeriod(goal, form.resetEachPeriod.checked);
  saveState();
  render();
  closeModal({ keepScroll: true });
  editingGoalId = null;
  const nowOn = goalResetsEnabled(goal);
  showToast(nowOn && !wasOn ? `🔁 Reset vanaf ${formatLongDate(nextPeriodStartAfter(getCurrentPeriodStart()))} ✓`
    : !nowOn && wasOn ? 'Resetten uitgezet ✓' : 'Spaardoel opgeslagen ✓');
}

// Categorieën hebben een soort: alleen uitgave, alleen inkomst, of beide (staat dan in beide lijsten).
const CATEGORY_TYPES = {
  expense: { label: 'Uitgave', cls: 'bg-rose-50 text-rose-600' },
  income: { label: 'Inkomst', cls: 'bg-emerald-50 text-emerald-600' },
  both: { label: 'Beide', cls: 'bg-brand-50 text-brand-700' }
};

function allCategories() {
  return [...new Set([...state.categories.expense, ...state.categories.income])];
}

function categoryType(name) {
  const e = state.categories.expense.includes(name), i = state.categories.income.includes(name);
  return e && i ? 'both' : i ? 'income' : 'expense';
}

function setCategoryType(name, type) {
  const inE = state.categories.expense.includes(name), inI = state.categories.income.includes(name);
  const wantE = type !== 'income', wantI = type !== 'expense';
  if (inE && !wantE && state.categories.expense.length === 1) { alert('Je hebt minstens één categorie voor uitgaven nodig.'); return false; }
  if (inI && !wantI && state.categories.income.length === 1) { alert('Je hebt minstens één categorie voor inkomsten nodig.'); return false; }
  if (wantE && !inE) state.categories.expense.push(name);
  if (!wantE && inE) state.categories.expense = state.categories.expense.filter(c => c !== name);
  if (wantI && !inI) state.categories.income.push(name);
  if (!wantI && inI) state.categories.income = state.categories.income.filter(c => c !== name);
  return true;
}

function addCategory(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  if (!name) return;
  const type = form.type.value || 'expense';
  if (allCategories().some(c => c.toLowerCase() === name.toLowerCase())) {
    const existing = allCategories().find(c => c.toLowerCase() === name.toLowerCase());
    if (!confirm(`"${existing}" bestaat al. Soort wijzigen naar ${CATEGORY_TYPES[type].label.toLowerCase()}?`)) return;
    setCategoryType(existing, type);
  } else {
    setCategoryType(name, type);
  }
  saveState();
  renderCategoriesList();
  populateCategorySelects();
  form.name.value = '';
}

function renderCategoriesList() {
  const list = document.getElementById('categories-list');
  list.innerHTML = allCategories().map((c, i) => {
    const t = CATEGORY_TYPES[categoryType(c)];
    return `
    <div class="flex items-center gap-2 bg-slate-50 rounded-xl pl-4 pr-2 py-2.5">
      <span class="font-medium text-slate-800 flex-1 min-w-0 truncate">${escapeHtml(c)}</span>
      <button onclick="cycleCategoryTypeAt(${i})" title="Tik om de soort te wijzigen" class="text-xs font-semibold px-2.5 py-1 rounded-full pressable shrink-0 ${t.cls}">${t.label}</button>
      <button onclick="removeCategoryAt(${i})" class="text-rose-500 text-sm font-medium pressable px-2 py-1 shrink-0">Verwijder</button>
    </div>`;
  }).join('');
}

function cycleCategoryTypeAt(index) {
  const name = allCategories()[index];
  if (name === undefined) return;
  const order = ['expense', 'income', 'both'];
  const next = order[(order.indexOf(categoryType(name)) + 1) % order.length];
  if (!setCategoryType(name, next)) return;
  saveState();
  renderCategoriesList();
  populateCategorySelects();
}

function removeCategoryAt(index) {
  const all = allCategories();
  if (all[index] !== undefined) removeCategory(all[index]);
}

function removeCategory(name) {
  const e = state.categories.expense.filter(c => c !== name), i = state.categories.income.filter(c => c !== name);
  if (!e.length || !i.length) return alert(`Je hebt minstens één categorie voor ${!e.length ? 'uitgaven' : 'inkomsten'} nodig.`);
  state.categories.expense = e;
  state.categories.income = i;
  saveState();
  renderCategoriesList();
  populateCategorySelects();
}

// Pot actions
function openPotAction(id) {
  currentPotId = id;
  const pot = state.pots.find(p => p.id === id);
  document.getElementById('pot-action-title').textContent = `${pot.emoji || '💰'} ${pot.name}`;
  openModal('pot-action');
}

function openAddToPot() {
  const amount = prompt('Hoeveel wil je toevoegen aan dit potje?');
  if (amount === null) return;
  const value = parseFloat(amount.replace(',', '.'));
  if (isNaN(value) || value <= 0) return alert('Ongeldig bedrag');
  const pot = state.pots.find(p => p.id === currentPotId);
  if (pot) {
    pot.balance = Math.round((pot.balance + value) * 100) / 100;
    saveState();
    render();
  }
  closeModal();
}

function openSpendFromPot() {
  const potId = currentPotId;
  closeModal();
  setTimeout(() => {
    openModal('add-expense');
    setTimeout(() => {
      document.getElementById('expense-pot').value = potId || '';
    }, 50);
  }, 200);
}

function deletePot() {
  if (!confirm('Potje verwijderen? Het gereserveerde geld is dan weer vrij te besteden (je saldo blijft gelijk).')) return;
  state.pots = state.pots.filter(p => p.id !== currentPotId);
  saveState();
  render();
  closeModal();
}

function parseAmountInput(text) {
  const value = Math.round(parseFloat(String(text).trim().replace(/\s|€/g, '').replace(',', '.')) * 100) / 100;
  return isNaN(value) || value <= 0 ? null : value;
}

function logGoalTransfer(goal, amount) {
  if (!Array.isArray(goal.deposits)) goal.deposits = [];
  goal.deposits.push({ id: uid(), amount, date: new Date().toISOString() });
}

// Geld naar een spaardoel: gaat van het beschikbaar saldo af (zie getAvailableBalance).
function addToGoal(id) {
  const goal = state.goals.find(g => g.id === id);
  if (!goal) return;
  const amount = prompt(`Hoeveel wil je naar "${goal.name}" overmaken?\nDit gaat van je beschikbaar saldo af.`);
  if (amount === null) return;
  const value = parseAmountInput(amount);
  if (value === null) return alert('Ongeldig bedrag');
  const free = getBalanceAfterPots();
  if (value > free && !confirm(`Je hebt nog ${formatMoney(free)} vrij (saldo min wat in je potjes zit). Toch ${formatMoney(value)} naar "${goal.name}"?`)) return;
  const before = goal.current;
  goal.current = Math.round((goal.current + value) * 100) / 100;
  logGoalTransfer(goal, value);
  saveState();
  render();
  showToast(`${formatMoney(value)} naar "${goal.name}" ✓`);
  if (before < goal.target && goal.current >= goal.target) celebrateGoal(goal);
  else haptic(10);
}

// Geld uit een spaardoel halen: komt terug op het beschikbaar saldo.
function withdrawFromGoal(id) {
  const goal = state.goals.find(g => g.id === id);
  if (!goal) return;
  const amount = prompt(`Hoeveel wil je uit "${goal.name}" halen? (max ${formatMoney(goal.current)})\nDit komt terug op je beschikbaar saldo.`);
  if (amount === null) return;
  const value = parseAmountInput(amount);
  if (value === null) return alert('Ongeldig bedrag');
  if (value > goal.current + 0.001) return alert(`Er staat maar ${formatMoney(goal.current)} in "${goal.name}".`);
  goal.current = Math.round((goal.current - value) * 100) / 100;
  logGoalTransfer(goal, -value);
  saveState();
  render();
  showToast(`${formatMoney(value)} terug naar je saldo ✓`);
  haptic(10);
}

// Settings
function exportData() {
  const dataStr = JSON.stringify(state, null, 2);
  const filename = `mijn-geld-backup-${today()}.json`;
  const blob = new Blob([dataStr], { type: 'application/json' });
  closeModal();
  try {
    const file = new File([blob], filename, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Mijn Geld backup' })
        .then(() => markBackupDone())
        .catch(() => {});
      return;
    }
  } catch (e) { /* val terug op download */ }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markBackupDone();
}

function clearAllData() {
  localStorage.removeItem('mijnGeldApp');
  state = {
    version: DATA_VERSION,
    transactions: [],
    pots: [],
    goals: [],
    categories: { expense: [...DEFAULT_CATEGORIES.expense], income: [...DEFAULT_CATEGORIES.income] },
    settings: { periodStartDay: DEFAULT_PERIOD_START_DAY },
    lastPeriodStart: null,
    history: [],
    recurring: []
  };
  ensurePeriodDefaults();
  render();
  closeModal();
}

// ==================== VASTE LASTEN ====================
const VAST_BADGE = ' <span class="inline-block align-middle ml-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-brand-50 text-brand-700">vast</span>';
let editingRecurringId = null;
let linkingTransactionId = null;

function sumAmounts(list) {
  return Math.round(list.reduce((s, x) => s + x.amount, 0) * 100) / 100;
}

// De periode waarin vaste lasten nu geboekt worden. Dit is de kalenderperiode volgens de startdag
// (zodat er ook geboekt wordt als je de nieuwe periode nog niet hebt gestart), maar nooit vóór de
// periode die je zelf al bent begonnen. Zo vallen alle boekingen altijd binnen je Uitgaven.
function recurringPeriod() {
  const cal = getCurrentPeriodStart();
  const end = getPeriodEnd(cal);
  let start = cal;
  if (state.lastPeriodStart && state.lastPeriodStart > cal && state.lastPeriodStart <= end) start = state.lastPeriodStart;
  return { start, end };
}

// Betaaldatum van een vaste last vanaf 'periodStart' (betaaldag geklemd op het einde van de maand).
function recurringDueDate(rec, periodStart) {
  const s = ymdToDate(periodStart);
  const dateIn = (y, m) => {
    const last = new Date(y, m + 1, 0).getDate();
    return toYmd(new Date(y, m, Math.min(rec.day, last)));
  };
  const first = dateIn(s.getFullYear(), s.getMonth());
  if (first >= periodStart) return first;
  return dateIn(s.getFullYear(), s.getMonth() + 1);
}

// De betaling van deze vaste last binnen de periode, of null als die in deze (verkorte) periode niet valt.
function recurringOccurrence(rec, period) {
  const due = recurringDueDate(rec, period.start);
  return due <= period.end ? due : null;
}

// Een betaling wordt herkend aan zijn maand (bijv. huur van oktober = '2026-10'). Dat blijft hetzelfde,
// ook als je de startdag van je periode verandert. Daardoor wordt een vaste last nooit twee keer geboekt.
function isRecurringBooked(rec, period, due = recurringOccurrence(rec, period)) {
  if (!due) return false;
  if (Array.isArray(rec.doneMonths) && rec.doneMonths.includes(due.slice(0, 7))) return true;
  if (rec.lastBookedPeriod && rec.lastBookedPeriod === period.start) return true;
  return state.transactions.some(t => t.recurringId === rec.id && txYmd(t) >= period.start && txYmd(t) <= period.end);
}

// Markeer de betaling als afgehandeld (geboekt of overgeslagen), ook als je de boeking later verwijdert.
function markRecurringHandled(rec, period, due) {
  if (!Array.isArray(rec.doneMonths)) rec.doneMonths = [];
  const month = due.slice(0, 7);
  if (!rec.doneMonths.includes(month)) rec.doneMonths.push(month);
  rec.doneMonths.sort();
  if (rec.doneMonths.length > 36) rec.doneMonths = rec.doneMonths.slice(-36);
  if (!rec.lastBookedPeriod || rec.lastBookedPeriod < period.start) rec.lastBookedPeriod = period.start;
}

// Actieve vaste lasten die deze periode nog moeten komen (nog niet geboekt), op datum.
function getUpcomingRecurring() {
  const period = recurringPeriod();
  return (state.recurring || [])
    .map(r => ({ r, due: recurringOccurrence(r, period) }))
    .filter(({ r, due }) => r.active && due && !isRecurringBooked(r, period, due))
    .map(({ r, due }) => ({ ...r, due }))
    .sort((a, b) => a.due.localeCompare(b.due));
}

function bookRecurring(rec, period) {
  const due = recurringOccurrence(rec, period);
  if (!due) return null;
  let potId = rec.potId && state.pots.some(p => p.id === rec.potId) ? rec.potId : null;
  let note = null;
  if (potId) {
    const pot = state.pots.find(p => p.id === potId);
    pot.balance = Math.round((pot.balance - rec.amount) * 100) / 100;
  }
  const [y, m, d] = due.split('-').map(Number);
  state.transactions.unshift({
    id: uid(), type: 'expense', amount: rec.amount, description: rec.name, category: rec.category,
    potId, date: new Date(y, m - 1, d, 9, 0, 0).toISOString(), recurringId: rec.id
  });
  markRecurringHandled(rec, period, due);
  return note;
}

// Boekt alle actieve vaste lasten waarvan de betaaldag deze periode is geweest. Nooit dubbel:
// per vaste last wordt bijgehouden welke maandbetaling al is geboekt (ook als je de boeking later verwijdert).
function runAutoBooking() {
  const period = recurringPeriod();
  const todayYmd = toYmd(new Date());
  const booked = [], notes = [];
  (state.recurring || []).forEach(rec => {
    const due = recurringOccurrence(rec, period);
    if (!rec.active || !due || due > todayYmd || isRecurringBooked(rec, period, due)) return;
    const note = bookRecurring(rec, period);
    booked.push(rec.name);
    if (note) notes.push(note);
  });
  if (!booked.length) return false;
  saveState();
  setTimeout(() => showToast(notes.length ? notes[0]
    : booked.length === 1 ? `Vaste last geboekt: ${booked[0]}` : `${booked.length} vaste lasten geboekt`), 300);
  return true;
}

// ==================== HERSTEL ====================
// Eerdere versies hielden vaste lasten bij per periode-startdatum. Als je de startdag veranderde,
// leek elke vaste last nog niet betaald en werd hij opnieuw geboekt (dubbel, soms vóór je periode
// zodat hij niet bij Uitgaven stond maar wel van je saldo af ging). Dit herstelt dat bij het laden.
// Veilig om elke keer te draaien: als er niets mis is, verandert er niets.
function repairRecurringData() {
  const r2 = x => Math.round(x * 100) / 100;
  let changed = false;
  // 1. Oude markering (periode) omzetten naar de maand van de betaling.
  (state.recurring || []).forEach(rec => {
    if (Array.isArray(rec.doneMonths)) return;
    rec.doneMonths = rec.lastBookedPeriod ? [recurringDueDate(rec, rec.lastBookedPeriod).slice(0, 7)] : [];
    changed = true;
  });
  // 2. Dubbele boekingen: dezelfde vaste last op dezelfde datum. De oudste blijft staan; latere kopieën
  //    die je niet zelf hebt aangepast worden verwijderd (geld uit een potje gaat terug naar dat potje).
  const groups = new Map();
  state.transactions.forEach((t, index) => {
    if (!t.recurringId || t.type !== 'expense') return;
    const key = t.recurringId + '|' + txYmd(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ t, index });
  });
  const removed = [];
  groups.forEach(list => {
    if (list.length < 2) return;
    list.sort((a, b) => b.index - a.index); // nieuwste transacties staan vooraan, dus hoogste index = oudste
    const keep = list[0].t;
    const rec = (state.recurring || []).find(r => r.id === keep.recurringId);
    list.slice(1).forEach(({ t }) => {
      const sameAsKeep = t.amount === keep.amount && (t.description || '') === (keep.description || '') && t.category === keep.category;
      const untouched = rec && t.amount === rec.amount && (t.description || '') === rec.name && t.category === rec.category;
      if (sameAsKeep || untouched) removed.push(t);
    });
  });
  if (removed.length) {
    const ids = new Set(removed.map(t => t.id));
    removed.forEach(t => {
      if (!t.potId) return;
      const pot = state.pots.find(p => p.id === t.potId);
      if (!pot) return;
      // Alleen terugzetten als de dubbele boeking in de huidige periode van het potje is afgeschreven.
      const createdMs = parseInt(String(t.id).slice(0, 8), 36);
      const created = createdMs > 1.5e12 && createdMs < 4e12 ? toYmd(new Date(createdMs)) : txYmd(t);
      if (created >= state.lastPeriodStart) pot.balance = r2(pot.balance + t.amount);
    });
    state.transactions = state.transactions.filter(t => !ids.has(t.id));
    // Afgesloten periodes met een verwijderde dubbele boeking opnieuw doorrekenen (potjesbudget/over blijven).
    state.history = (state.history || []).map(h => {
      if (!removed.some(t => txYmd(t) >= h.start && txYmd(t) <= h.end)) return h;
      const fresh = makePeriodSnapshot(h.start, h.end, null);
      const spent = {};
      (fresh.pots || []).forEach(p => { spent[p.id] = p.spent; });
      return { ...h, income: fresh.income, expense: fresh.expense, net: fresh.net, categories: fresh.categories, count: fresh.count,
        pots: (h.pots && h.pots.length) ? h.pots.map(p => ({ ...p, spent: spent[p.id] || 0 })) : fresh.pots };
    });
    changed = true;
  }
  // 3. Exact dubbele periodes in de geschiedenis (zelfde begin en eind): één houden.
  const seen = new Set();
  const before = (state.history || []).length;
  state.history = (state.history || []).filter(h => {
    const key = h.start + '|' + h.end;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (state.history.length !== before) changed = true;
  if (changed) saveState();
  return removed;
}

function openBalanceBreakdown() {
  const upcoming = getUpcomingRecurring();
  const saldo = getAvailableBalance(), pots = getPotsTotal(), afterPots = getBalanceAfterPots();
  const fixedAll = sumAmounts(upcoming), fixed = getUpcomingFixedImpact(upcoming), fromPots = Math.round((fixedAll - fixed) * 100) / 100;
  const free = Math.round((afterPots - fixed) * 100) / 100;
  const toGoals = getGoalTransfersTotal(), toGoalsPeriod = getGoalTransfersThisPeriod();
  const signed = x => (x < 0 ? '+' : '−') + formatMoney(Math.abs(x));
  const row = (label, value, cls = 'text-slate-900', sub = '') => `
    <div class="flex items-center justify-between py-2.5">
      <span class="text-slate-600">${label}${sub ? `<span class="block text-xs text-slate-400">${sub}</span>` : ''}</span>
      <span class="font-semibold tabular-nums ${cls}">${value}</span>
    </div>`;
  const head = (icon, text, first) => `<h4 class="text-xs font-semibold text-slate-400 uppercase tracking-wider ${first ? '' : 'mt-4 '}mb-1.5">${icon} ${text}</h4>`;
  const goalsNow = getGoalsTotal();
  document.getElementById('balance-body').innerHTML = `
    ${head('🎯', 'Saldo & spaardoelen', true)}
    <div id="bd-goals" class="bg-slate-50 rounded-2xl px-4 divide-y divide-slate-200/70">
      ${toGoals !== 0 ? row('Inkomsten − uitgaven', formatMoney(getIncomeMinusExpense())) +
        row('🎯 Naar spaardoelen', signed(toGoals), 'goal-text', `deze periode ${signed(toGoalsPeriod)} · los van je potjes`) : ''}
      ${row('<span class="font-semibold text-slate-800">Beschikbaar saldo</span>', formatMoney(saldo), saldo < 0 ? 'text-rose-600' : 'text-slate-900')}
    </div>
    ${goalsNow > 0 ? `<p class="text-[11px] text-slate-400 mt-1.5 px-1">In je spaardoelen staat in totaal ${formatMoney(goalsNow)}. Dat telt niet mee als potje.</p>` : ''}
    ${head('🏺', 'Potjes')}
    <div id="bd-pots" class="bg-slate-50 rounded-2xl px-4 divide-y divide-slate-200/70">
      ${row('In potjes', '−' + formatMoney(pots), 'text-brand-700', 'alleen je potjes, geen spaardoelen')}
      ${row('<span class="font-semibold text-slate-800">Na potjes</span>', formatMoney(afterPots), afterPots < 0 ? 'text-rose-600' : 'text-slate-900')}
    </div>
    ${head('📅', 'Vaste lasten')}
    <div class="bg-slate-50 rounded-2xl px-4 divide-y divide-slate-200/70">
      ${row('Vaste lasten nog te gaan', '−' + formatMoney(fixed), 'text-rose-600', (upcoming.length ? `${upcoming.length} t/m ${formatShortDate(recurringPeriod().end)}` : 'niets meer deze periode') + (fromPots > 0 ? ` · ${formatMoney(fromPots)} al gereserveerd in potjes` : ''))}
      <div id="bd-free">${row('<span class="font-bold text-slate-900">Vrij te besteden</span>', formatMoney(free), free < 0 ? 'text-rose-600 text-lg' : 'text-emerald-600 text-lg')}</div>
      ${free < 0 ? `<p id="bd-free-note" class="text-xs text-rose-600 py-2">Je komt ${formatMoney(-free)} tekort deze periode.</p>` : ''}
    </div>
    ${upcoming.length ? `
      <h4 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mt-5 mb-2">Nog te gaan</h4>
      <div class="space-y-1.5">${upcoming.map(r => `
        <div class="flex items-center justify-between bg-slate-50 rounded-xl px-3.5 py-2.5 text-sm">
          <span class="text-slate-700 truncate">${escapeHtml(r.name)} <span class="text-xs text-slate-400">· ${formatShortDate(r.due)}</span></span>
          <span class="font-semibold tabular-nums text-slate-900">${formatMoney(r.amount)}</span>
        </div>`).join('')}</div>` : ''}
    <button onclick="openRecurring()" class="w-full mt-4 py-3.5 bg-brand-50 text-brand-700 font-semibold rounded-2xl pressable">📅 Vaste lasten beheren</button>`;
  openModal('balance');
}

function renderRecurringList() {
  const period = recurringPeriod();
  const { start, end } = period;
  const todayYmd = toYmd(new Date());
  const list = state.recurring || [];
  document.getElementById('recurring-period').textContent = `Deze periode: ${formatRange(start, end)}`;
  const perMonth = sumAmounts(list.filter(r => r.active));
  const paidTx = transactionsBetween(start, end).filter(t => t.recurringId);
  const paid = sumAmounts(paidTx);
  const upcoming = getUpcomingRecurring();
  const tile = (label, value, cls) => `
    <div class="bg-slate-50 rounded-2xl p-3">
      <p class="text-[11px] text-slate-400">${label}</p>
      <p class="font-bold text-[15px] tabular-nums mt-0.5 ${cls}">${value}</p>
    </div>`;
  const items = [...list].sort((a, b) => (b.active - a.active) || a.day - b.day);
  document.getElementById('recurring-body').innerHTML = `
    <div class="grid grid-cols-3 gap-2 mb-4">
      ${tile('Per maand', formatMoney(perMonth), 'text-slate-900')}
      ${tile('Al betaald', formatMoney(paid), 'text-emerald-600')}
      ${tile('Nog te gaan', formatMoney(sumAmounts(upcoming)), 'text-rose-600')}
    </div>
    ${!items.length ? `
      <div class="text-center py-10">
        <div class="w-16 h-16 mx-auto mb-3 rounded-full bg-slate-100 flex items-center justify-center text-2xl">📅</div>
        <p class="text-slate-400 text-sm">Nog geen vaste lasten.<br>Voeg bijvoorbeeld je huur of abonnementen toe.</p>
      </div>` : `<div class="space-y-2">${items.map(r => {
        const pot = r.potId ? state.pots.find(p => p.id === r.potId) : null;
        const due = recurringOccurrence(r, period);
        const bookedTx = paidTx.find(t => t.recurringId === r.id);
        let status;
        if (!r.active) status = '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">Inactief</span>';
        else if (!due && !bookedTx) status = `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Volgende periode · ${formatShortDate(recurringDueDate(r, addDaysYmd(end, 1)))}</span>`;
        else if (bookedTx || isRecurringBooked(r, period, due)) status = bookedTx
          ? `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">Betaald ${formatShortDate(txYmd(bookedTx))}</span>`
          : '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Overgeslagen</span>';
        else status = `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">${due <= todayYmd ? 'Vandaag' : 'Gepland ' + formatShortDate(due)}</span>`;
        return `
          <div onclick="openRecurringForm('${r.id}')" class="pressable cursor-pointer flex items-center gap-3 bg-slate-50 rounded-2xl px-3.5 py-3 ${r.active ? '' : 'opacity-60'}">
            <div class="w-10 h-10 rounded-xl bg-white flex flex-col items-center justify-center shrink-0 leading-none">
              <span class="text-[9px] text-slate-400 uppercase">dag</span><span class="font-bold text-slate-800 text-sm">${r.day}</span>
            </div>
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-slate-900 truncate text-[15px]">${escapeHtml(r.name)}</p>
              <p class="text-xs text-slate-400 truncate">${escapeHtml(r.category)}${pot ? ' · ' + escapeHtml(pot.emoji || '💰') + ' ' + escapeHtml(pot.name) : ''}</p>
            </div>
            <div class="text-right shrink-0">
              <p class="font-bold text-[15px] tabular-nums text-slate-900">${formatMoney(r.amount)}</p>
              <div class="mt-0.5">${status}</div>
            </div>
          </div>`;
      }).join('')}</div>`}`;
  updateRecurringImportButton();
  const count = list.filter(r => r.active).length;
  const el = document.getElementById('settings-recurring-count');
  if (el) el.textContent = count ? `${count} actief` : '';
}

function openRecurring() {
  renderRecurringList();
  closeModal();
  setTimeout(() => openModal('recurring'), 200);
}

function backToRecurring() {
  openRecurring();
}

function openRecurringForm(id, prefill = null) {
  const rec = id ? state.recurring.find(r => r.id === id) : null;
  editingRecurringId = rec ? rec.id : null;
  linkingTransactionId = prefill ? prefill.transactionId : null;
  const note = document.getElementById('recurring-link-note');
  note.classList.toggle('hidden', !prefill);
  if (prefill) note.textContent = `Gemaakt van je transactie van ${formatLongDate(prefill.dateYmd)}. Die telt als betaling van deze periode, dus hij wordt niet dubbel geboekt.`;
  const form = document.getElementById('recurring-form');
  form.reset();
  document.getElementById('recurring-form-title').textContent = rec ? 'Vaste last bewerken' : 'Nieuwe vaste last';
  document.getElementById('recurring-delete').classList.toggle('hidden', !rec);
  const cats = [...state.categories.expense];
  if (rec && rec.category && !cats.includes(rec.category)) cats.unshift(rec.category);
  if (prefill && prefill.category && !cats.includes(prefill.category)) cats.unshift(prefill.category);
  form.category.innerHTML = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  form.potId.innerHTML = '<option value="">— Geen potje —</option>' +
    state.pots.map(p => `<option value="${p.id}">${escapeHtml(p.emoji || '💰')} ${escapeHtml(p.name)}</option>`).join('');
  form.name.value = rec ? rec.name : '';
  form.amount.value = rec ? rec.amount : '';
  form.day.value = rec ? rec.day : '';
  form.category.value = rec ? rec.category : (cats.includes('Wonen') ? 'Wonen' : cats[0]);
  form.potId.value = rec && rec.potId && state.pots.some(p => p.id === rec.potId) ? rec.potId : '';
  form.active.checked = rec ? !!rec.active : true;
  if (prefill) {
    form.name.value = prefill.name;
    form.amount.value = prefill.amount;
    form.day.value = prefill.day;
    form.category.value = prefill.category;
    form.potId.value = prefill.potId && state.pots.some(p => p.id === prefill.potId) ? prefill.potId : '';
  }
  closeModal();
  setTimeout(() => openModal('recurring-form'), 200);
}

function saveRecurring(e) {
  e.preventDefault();
  const form = e.target;
  const amount = Math.round(parseFloat(String(form.amount.value).replace(',', '.')) * 100) / 100;
  const day = parseInt(form.day.value, 10);
  if (isNaN(amount) || amount <= 0) return alert('Ongeldig bedrag');
  if (isNaN(day) || day < 1 || day > 31) return alert('Kies een betaaldag tussen 1 en 31.');
  let rec = editingRecurringId ? state.recurring.find(r => r.id === editingRecurringId) : null;
  const data = { name: form.name.value.trim(), amount, day, category: form.category.value, potId: form.potId.value || null, active: form.active.checked };
  if (!data.name) return alert('Vul een naam in.');
  if (rec) Object.assign(rec, data);
  else { rec = { id: uid(), ...data, lastBookedPeriod: null, doneMonths: [], createdAt: new Date().toISOString() }; state.recurring.push(rec); }

  // Gemaakt vanuit een bestaande transactie: koppel die als boeking van zijn periode (geen dubbele boeking).
  const linkTx = linkingTransactionId ? state.transactions.find(t => t.id === linkingTransactionId) : null;
  linkingTransactionId = null;
  if (linkTx) linkTransactionToRecurring(linkTx, rec);

  // Betaaldag deze periode al geweest en nog niet geboekt? Vraag het, zodat er niets ongemerkt dubbel komt.
  const period = recurringPeriod();
  const due = recurringOccurrence(rec, period);
  let note = null;
  if (rec.active && due && !isRecurringBooked(rec, period, due) && due <= toYmd(new Date())) {
    if (confirm(`De betaaldag (${formatLongDate(due)}) is deze periode al geweest. Wil je "${rec.name}" nu ook voor deze periode boeken?\n\nKies Annuleren als je hem al zelf hebt ingevoerd.`)) {
      note = bookRecurring(rec, period);
    } else {
      markRecurringHandled(rec, period, due); // overslaan deze periode
    }
  }
  saveState();
  render();
  showToast(note || 'Vaste last opgeslagen ✓');
  openRecurring();
}

function deleteRecurring() {
  const rec = state.recurring.find(r => r.id === editingRecurringId);
  if (!rec) return;
  if (!confirm(`Vaste last "${rec.name}" verwijderen? Eerdere boekingen blijven gewoon staan.`)) return;
  state.recurring = state.recurring.filter(r => r.id !== rec.id);
  saveState();
  render();
  openRecurring();
}

function linkTransactionToRecurring(tx, rec) {
  tx.recurringId = rec.id;
  // De transactie telt als betaling van de periode waarin hij valt.
  const ymd = txYmd(tx);
  const cur = recurringPeriod();
  const start = ymd >= cur.start && ymd <= cur.end ? cur.start : getCurrentPeriodStart(new Date(tx.date));
  const period = { start, end: start === cur.start ? cur.end : getPeriodEnd(start) };
  const due = recurringOccurrence(rec, period);
  if (due) markRecurringHandled(rec, period, due);
}

function makeRecurringFromEditing() {
  const t = state.transactions.find(x => x.id === editingTransactionId);
  if (!t) return;
  const dateYmd = txYmd(t);
  openRecurringForm(null, { transactionId: t.id, name: t.description || t.category, amount: t.amount,
    category: t.category, potId: t.potId, day: Number(dateYmd.slice(8, 10)), dateYmd });
}

const RECURRING_CATEGORY = 'vaste lasten';

function getRecurringImportCandidates() {
  return transactionsBetween(state.lastPeriodStart, null)
    .filter(t => t.type === 'expense' && !t.recurringId && (t.category || '').trim().toLowerCase() === RECURRING_CATEGORY)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function updateRecurringImportButton() {
  const btn = document.getElementById('recurring-import-btn');
  const n = getRecurringImportCandidates().length;
  btn.classList.toggle('hidden', n === 0);
  btn.textContent = `⤵︎ Importeer uit transacties (${n})`;
}

function openRecurringImport() {
  const items = getRecurringImportCandidates();
  const existing = new Set((state.recurring || []).map(r => r.name.trim().toLowerCase()));
  document.getElementById('recurring-import-list').innerHTML = items.map(t => {
    const name = t.description || t.category;
    const dup = existing.has(name.trim().toLowerCase());
    return `
    <label class="flex items-center gap-3 bg-slate-50 rounded-2xl px-3.5 py-3 cursor-pointer">
      <input type="checkbox" data-tx-id="${t.id}" ${dup ? '' : 'checked'} onchange="updateRecurringImportCount()" class="w-5 h-5 rounded-md accent-indigo-600 shrink-0">
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-slate-900 truncate text-[15px]">${escapeHtml(name)}</p>
        <p class="text-xs text-slate-400 tabular-nums">${formatMoney(t.amount)} · ${formatShortDate(txYmd(t))}${dup ? ' · <span class="text-amber-600">bestaat al</span>' : ''}</p>
      </div>
      <div class="shrink-0 text-center">
        <p class="text-[10px] text-slate-400 uppercase">dag</p>
        <input type="number" min="1" max="31" step="1" inputmode="numeric" data-day-for="${t.id}" value="${Number(txYmd(t).slice(8, 10))}" onclick="event.stopPropagation()"
               class="w-14 px-1 py-2 bg-white border border-slate-200 rounded-xl text-center font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500/40">
      </div>
    </label>`;
  }).join('') || '<p class="text-sm text-slate-400 text-center py-6">Geen uitgaven met categorie "Vaste lasten" in deze periode.</p>';
  updateRecurringImportCount();
  closeModal();
  setTimeout(() => openModal('recurring-import'), 200);
}

function updateRecurringImportCount() {
  const n = document.querySelectorAll('#recurring-import-list input[type=checkbox]:checked').length;
  const btn = document.getElementById('recurring-import-submit');
  btn.textContent = n ? `${n} omzetten naar vaste lasten` : 'Niets geselecteerd';
  btn.disabled = !n;
  btn.classList.toggle('opacity-50', !n);
}

function confirmRecurringImport(e) {
  e.preventDefault();
  const checked = [...document.querySelectorAll('#recurring-import-list input[type=checkbox]:checked')];
  for (const cb of checked) {
    const day = parseInt(document.querySelector(`[data-day-for="${cb.dataset.txId}"]`).value, 10);
    if (isNaN(day) || day < 1 || day > 31) return alert('Kies voor elke vaste last een betaaldag tussen 1 en 31.');
  }
  let n = 0;
  checked.forEach(cb => {
    const t = state.transactions.find(x => x.id === cb.dataset.txId);
    if (!t || t.recurringId) return;
    const day = parseInt(document.querySelector(`[data-day-for="${t.id}"]`).value, 10);
    const rec = { id: uid(), name: t.description || t.category, amount: t.amount, day, category: t.category,
      potId: t.potId || null, active: true, lastBookedPeriod: null, doneMonths: [], createdAt: new Date().toISOString() };
    state.recurring.push(rec);
    linkTransactionToRecurring(t, rec);
    n++;
  });
  saveState();
  render();
  showToast(n === 1 ? '1 vaste last aangemaakt ✓' : `${n} vaste lasten aangemaakt ✓`);
  openRecurring();
}


// ==================== BACK-UP TERUGZETTEN ====================
const BACKUP_KEY = 'mijnGeldLastBackup';
const BACKUP_DISMISS_KEY = 'mijnGeldBackupDismissedAt';
const BACKUP_REMIND_DAYS = 30;

function openImportData() {
  const input = document.getElementById('import-file');
  input.value = '';
  input.click();
}

// Controleer of een bestand een geldige Mijn Geld-back-up is. Geeft een foutmelding (string) of null.
function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Dit bestand is geen Mijn Geld-back-up.';
  if (!Array.isArray(data.transactions)) return 'Dit bestand is geen Mijn Geld-back-up (geen transacties gevonden).';
  for (const key of ['pots', 'goals', 'history', 'recurring']) {
    if (data[key] != null && !Array.isArray(data[key])) return 'De back-up is beschadigd.';
  }
  if (data.categories != null && (typeof data.categories !== 'object' || !Array.isArray(data.categories.expense) || !Array.isArray(data.categories.income))) {
    return 'De back-up is beschadigd (categorieën).';
  }
  const badTx = data.transactions.find(t => !t || (t.type !== 'income' && t.type !== 'expense') ||
    typeof t.amount !== 'number' || !isFinite(t.amount) || isNaN(new Date(t.date).getTime()));
  if (badTx) return 'De back-up bevat een ongeldige transactie.';
  if ((data.pots || []).some(pt => !pt || typeof pt.balance !== 'number')) return 'De back-up bevat een ongeldig potje.';
  if ((data.goals || []).some(g => !g || typeof g.current !== 'number' || typeof g.target !== 'number' ||
    (g.deposits != null && (!Array.isArray(g.deposits) || g.deposits.some(d => !d || typeof d.amount !== 'number' || !isFinite(d.amount) || isNaN(new Date(d.date).getTime())))) ||
    (g.resetEachPeriod != null && typeof g.resetEachPeriod !== 'boolean') ||
    (g.lastResetPeriod != null && (typeof g.lastResetPeriod !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(g.lastResetPeriod))))) return 'De back-up bevat een ongeldig spaardoel.';
  if (typeof data.version === 'number' && data.version > DATA_VERSION) return 'Deze back-up komt uit een nieuwere versie van de app.';
  return null;
}

// Zet een back-up (als tekst) terug. Bij elke fout blijven de huidige gegevens ongewijzigd.
function importBackupText(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { alert('Dit bestand kon niet worden gelezen. Kies een .json-back-up van Mijn Geld.'); return false; }
  const error = validateBackup(data);
  if (error) { alert(error + ' Je huidige gegevens zijn niet aangepast.'); return false; }
  const n = data.transactions.length;
  if (!confirm(`Dit vervangt al je huidige gegevens door de back-up (${n} ${n === 1 ? 'transactie' : 'transacties'}). Doorgaan?`)) return false;

  const previousRaw = localStorage.getItem('mijnGeldApp');
  const previousState = state;
  try {
    if (previousRaw) localStorage.setItem('mijnGeldApp.voorImport', previousRaw);
    localStorage.setItem('mijnGeldApp', JSON.stringify(data));
    loadState();
    if (state === previousState) throw new Error('laden mislukt');
    ensurePeriodDefaults();
    repairRecurringData();
    runAutoBooking();
    goalResetToast(runGoalResets());
    saveState();
  } catch (e) {
    console.error('Import mislukt', e);
    state = previousState;
    if (previousRaw) localStorage.setItem('mijnGeldApp', previousRaw); else localStorage.removeItem('mijnGeldApp');
    alert('Terugzetten is mislukt. Je huidige gegevens zijn niet aangepast.');
    return false;
  }
  markBackupDone();
  closeModal();
  switchTab('overview');
  render();
  haptic([10, 40, 10]);
  showToast('Back-up teruggezet ✓');
  return true;
}

function handleImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { alert('Dit bestand is te groot voor een Mijn Geld-back-up.'); return; }
  const reader = new FileReader();
  reader.onload = () => importBackupText(String(reader.result || ''));
  reader.onerror = () => alert('Dit bestand kon niet worden gelezen.');
  reader.readAsText(file);
}

// ==================== BACK-UPHERINNERING ====================
function markBackupDone() {
  try { localStorage.setItem(BACKUP_KEY, new Date().toISOString()); } catch (e) {}
  renderBackupBanner();
}

function backupReminderDue() {
  const hasData = state.transactions.length || state.pots.length || state.goals.length;
  if (!hasData) return false;
  const now = Date.now();
  const dismissed = Date.parse(localStorage.getItem(BACKUP_DISMISS_KEY) || '');
  if (!isNaN(dismissed) && now - dismissed < 7 * 86400000) return false;
  const last = Date.parse(localStorage.getItem(BACKUP_KEY) || '');
  return isNaN(last) || now - last >= BACKUP_REMIND_DAYS * 86400000;
}

function renderBackupBanner() {
  const el = document.getElementById('backup-banner');
  if (!el) return;
  const due = backupReminderDue();
  if (due) {
    const last = Date.parse(localStorage.getItem(BACKUP_KEY) || '');
    const days = isNaN(last) ? null : Math.floor((Date.now() - last) / 86400000);
    document.getElementById('backup-banner-text').textContent = days === null
      ? 'Je hebt nog nooit een back-up gemaakt. Bewaar je gegevens veilig.'
      : `Je laatste back-up is ${days} dagen geleden. Tijd voor een nieuwe!`;
  }
  el.classList.toggle('hidden', !due);
}

function dismissBackupBanner(e) {
  if (e) e.stopPropagation();
  localStorage.setItem(BACKUP_DISMISS_KEY, new Date().toISOString());
  const el = document.getElementById('backup-banner');
  el.classList.add('banner-leave');
  setTimeout(() => { el.classList.remove('banner-leave'); renderBackupBanner(); }, 260);
}

// ==================== ZOEKEN ====================
function getSearchQuery() {
  const input = document.getElementById('search-input');
  return input ? input.value.trim() : '';
}

function normalizeText(str) {
  return String(str ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Zoek in alle periodes op omschrijving, categorie en bedrag (bijv. "12,50", "12.5" of "€ 900").
function searchTransactions(query) {
  const q = normalizeText(query);
  const amountQ = q.replace(/[€\s]/g, '').replace(',', '.');
  const isAmount = /^\d+(\.\d{0,2})?$/.test(amountQ);
  return state.transactions.filter(t => {
    if (normalizeText(t.description).includes(q) || normalizeText(t.category).includes(q)) return true;
    const pot = t.potId ? state.pots.find(p => p.id === t.potId) : null;
    if (pot && normalizeText(pot.name).includes(q)) return true;
    if (isAmount) {
      const fixed = Number(t.amount).toFixed(2);
      if (fixed === Number(amountQ).toFixed(2) || fixed.startsWith(amountQ) || String(t.amount).startsWith(amountQ)) return true;
    }
    return normalizeText(formatMoney(t.amount)).replace(/\s/g, '').includes(q.replace(/\s/g, ''));
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

let searchTimer = null;
function onSearchInput() {
  const input = document.getElementById('search-input');
  document.getElementById('search-clear').classList.toggle('hidden', !input.value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderTransactions, 120);
}

function clearSearch() {
  const input = document.getElementById('search-input');
  input.value = '';
  document.getElementById('search-clear').classList.add('hidden');
  renderTransactions();
  haptic(6);
}

// ==================== ANIMATIES ====================
const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function haptic(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}

function replayAnimation(el, cls) {
  if (!el || reduceMotion()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// Laat een bedrag soepel naar de nieuwe waarde tellen.
function countUp(el, value, duration = 750) {
  if (!el) return;
  const target = Math.round((value || 0) * 100) / 100;
  const from = el.dataset.value !== undefined ? parseFloat(el.dataset.value) : 0;
  el.dataset.value = String(target);
  if (el._countRaf && window.cancelAnimationFrame) cancelAnimationFrame(el._countRaf);
  if (from === target || reduceMotion() || typeof window.requestAnimationFrame !== 'function' || document.hidden) {
    el.textContent = formatMoney(target);
    return;
  }
  const start = performance.now();
  const ease = x => 1 - Math.pow(1 - x, 4);
  const step = now => {
    const p = Math.min(1, (now - start) / duration);
    el.textContent = formatMoney(p >= 1 ? target : from + (target - from) * ease(p));
    if (p < 1) el._countRaf = requestAnimationFrame(step);
  };
  el._countRaf = requestAnimationFrame(step);
}

// Grafieken in Analyse laten opbouwen.
function animateCharts() {
  const el = document.getElementById('analysis-content');
  if (!el || reduceMotion()) return;
  el.querySelectorAll('polyline').forEach(pl => pl.setAttribute('pathLength', '1'));
  replayAnimation(el, 'charts-in');
}

// Confetti als een spaardoel 100% haalt.
function celebrateGoal(goal) {
  haptic([20, 60, 20, 60, 40]);
  showToast(`🎉 Gefeliciteerd! "${goal.name}" is bereikt!`);
  if (reduceMotion()) return;
  launchConfetti();
}

function launchConfetti() {
  const canvas = document.createElement('canvas');
  if (!canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.className = 'confetti-canvas';
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);
  const colors = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#0ea5e9', '#ec4899', '#a78bfa'];
  const parts = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 60, y: H * 0.35,
    vx: (Math.random() - 0.5) * 13, vy: -Math.random() * 13 - 4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
    c: colors[Math.floor(Math.random() * colors.length)]
  }));
  const start = performance.now();
  const frame = now => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = t > 2000 ? Math.max(0, 1 - (t - 2000) / 800) : 1;
    parts.forEach(p => {
      p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    });
    if (t < 2800) requestAnimationFrame(frame); else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// Lichte trilling bij het indrukken van knoppen (waar ondersteund).
document.addEventListener('click', e => {
  if (e.target.closest && e.target.closest('.pressable, button')) haptic(5);
}, { passive: true });

// ==================== INIT ====================
loadState();
ensurePeriodDefaults();
const repairedDuplicates = repairRecurringData();
runAutoBooking();
const startupGoalResets = runGoalResets();
if (startupGoalResets.length) saveState(); // sync.js is dan nog niet geladen; die uploadt de reset na het ophalen
render();
goalResetToast(startupGoalResets);
if (repairedDuplicates.length) {
  setTimeout(() => showToast(repairedDuplicates.length === 1
    ? '1 dubbele vaste last hersteld ✓'
    : `${repairedDuplicates.length} dubbele vaste lasten hersteld ✓`), 900);
}
// Controleer opnieuw als de app terugkomt uit de achtergrond (bijv. de volgende dag).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  let changed = runAutoBooking();
  // Met cloud-sync doet sync.js de reset ná het ophalen van de nieuwste gegevens (anders kan een
  // verouderde lokale versie de cloud overschrijven). Zonder sync (of offline) gebeurt het hier.
  const syncHandles = typeof window.mgSyncActive === 'function' && window.mgSyncActive() && navigator.onLine !== false;
  if (!syncHandles) {
    const resets = runGoalResets();
    if (resets.length) { saveState(); goalResetToast(resets); changed = true; }
  }
  if (changed) render();
  renderPeriodBanner();
});

// ==================== UPDATES ====================
// Nieuwe versie online? Dan neemt de nieuwe service worker het over en herladen we één keer.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;

  const reloadForUpdate = () => {
    if (reloading) return;
    // Lusbeveiliging: hooguit één automatische herlaadactie per 30 seconden.
    const last = parseInt(sessionStorage.getItem('swReloadAt') || '0', 10);
    if (Date.now() - last < 30000) return;
    // Niet herladen terwijl een formulier/sheet open is; wacht tot die dicht is.
    if (document.querySelector('.modal.open')) {
      setTimeout(reloadForUpdate, 1000);
      return;
    }
    reloading = true;
    sessionStorage.setItem('swReloadAt', String(Date.now()));
    try { window.scrollTo(0, 0); } catch (e) {}
    location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Bij de allereerste installatie is er niets te verversen.
    if (hadController) reloadForUpdate();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => {
        const check = () => reg.update().catch(() => {});
        check();
        document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      })
      .catch(err => console.warn('SW registratie mislukt', err));
  });
}

// ===== v21: donkere modus (apparaat-instelling, niet gesynchroniseerd) =====
const THEME_KEY = 'mijnGeld.theme';
function getThemePref() { try { const t = localStorage.getItem(THEME_KEY); return (t === 'light' || t === 'dark') ? t : 'auto'; } catch (e) { return 'auto'; } }
function applyTheme(animate) {
  const pref = getThemePref();
  const dark = pref === 'dark' || (pref === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  const was = root.getAttribute('data-theme') === 'dark';
  if (animate && was !== dark) { root.classList.add('theme-anim'); clearTimeout(applyTheme._t); applyTheme._t = setTimeout(() => root.classList.remove('theme-anim'), 400); }
  if (dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.setAttribute('aria-pressed', b.dataset.themeOpt === pref ? 'true' : 'false'));
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', '#0f172a');
}
function setTheme(pref) {
  try { if (pref === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref); } catch (e) {}
  applyTheme(true);
}
applyTheme(false);
try { const mq = matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener ? mq.addEventListener('change', () => applyTheme(true)) : mq.addListener(() => applyTheme(true))); } catch (e) {}
