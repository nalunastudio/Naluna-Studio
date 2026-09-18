// FUNNEL PERIOD (2026-09-18, Funnel Analytics) — logica PURA de rezolvare a granitelor unei
// perioade de raportare (Month/Week/Day/Custom) pentru /admin/orders — separata complet de orice
// acces DB, testabila izolat, FARA Date.now()/fus orar local al serverului implicat.
//
// PRINCIPIU: aceasta functie manipuleaza STRICT date calendaristice (YYYY-MM-DD), niciodata o
// instanta reala de timp — Date.UTC(...) e folosit DOAR ca un calculator de calendar (aritmetica
// pe an/luna/zi), niciodata ca "ora curenta" sau ca reprezentare a unui moment real. Conversia
// efectiva a acestor date calendaristice in instante UTC (singurul punct unde regulile DST ale
// Europe/London conteaza cu adevarat) se intampla STRICT in SQL, prin `<data> AT TIME ZONE
// 'Europe/London'` (db.js) — foloseste baza de date IANA reala a Postgres, niciodata o
// aproximare proprie in JS.
//
// SAPTAMANA = ISO 8601, Luni-Duminica (regula aleasa explicit si documentata in raportul FAZA 2)
// — coincide cu date_trunc('week', ...) din Postgres, deci acelasi mod de a gandi "saptamana" in
// tot codul (JS si SQL).

function pad2(n) { return String(n).padStart(2, '0'); }
function toDateStr(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return toDateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function firstOfMonth(year, month) { return toDateStr(year, month, 1); }
function firstOfNextMonth(year, month) {
  const dt = new Date(Date.UTC(year, month, 1)); // month e 1-indexat -> luna urmatoare, ziua 1
  return toDateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// Luni (ISO 8601) al saptamanii care contine dateStr.
function isoMondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Duminica..6=Sambata
  const diffToMonday = (dow === 0) ? -6 : (1 - dow);
  return addDays(dateStr, diffToMonday);
}

// Rezolva un descriptor de perioada (venit din query params Admin) in { startDate,
// endDateExclusive } — ambele date calendaristice YYYY-MM-DD, capatul din urma EXCLUSIV
// (conventie consecventa in tot codul: `>= startDate AND < endDateExclusive`, fara ambiguitate
// la limita zilei/saptamanii/lunii). Arunca o eroare descriptiva pentru orice input invalid —
// apelantul (server.js) o transforma intr-un 400, niciodata o presupunere silentioasa.
function resolvePeriodBounds(period) {
  if (!period || typeof period !== 'object') throw new Error('period necesar');

  if (period.type === 'month') {
    const year = Number(period.year);
    const month = Number(period.month);
    if (!Number.isInteger(year) || year < 2000 || year > 3000) throw new Error('year invalid');
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month invalid (1-12)');
    return { startDate: firstOfMonth(year, month), endDateExclusive: firstOfNextMonth(year, month) };
  }

  if (period.type === 'week') {
    if (!DATE_RE.test(period.anchorDate || '')) throw new Error('anchorDate invalid (asteptat YYYY-MM-DD)');
    const monday = isoMondayOf(period.anchorDate);
    return { startDate: monday, endDateExclusive: addDays(monday, 7) };
  }

  if (period.type === 'day') {
    if (!DATE_RE.test(period.date || '')) throw new Error('date invalid (asteptat YYYY-MM-DD)');
    return { startDate: period.date, endDateExclusive: addDays(period.date, 1) };
  }

  if (period.type === 'custom') {
    if (!DATE_RE.test(period.startDate || '') || !DATE_RE.test(period.endDate || '')) {
      throw new Error('startDate/endDate invalid (asteptat YYYY-MM-DD)');
    }
    if (period.endDate < period.startDate) throw new Error('endDate nu poate fi inainte de startDate');
    return { startDate: period.startDate, endDateExclusive: addDays(period.endDate, 1) };
  }

  throw new Error('period.type necunoscut: ' + period.type);
}

// Lista completa a zilelor [startDate, endDateExclusive) — folosita pentru a umple cu 0 zilele
// fara date in seriile de tip trend (Revenue & Orders Trend), ca sa nu apara goluri in grafic.
function listDaysInRange(startDate, endDateExclusive) {
  const days = [];
  let cursor = startDate;
  while (cursor < endDateExclusive) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

module.exports = { resolvePeriodBounds, listDaysInRange, addDays, isoMondayOf, firstOfMonth, firstOfNextMonth };
