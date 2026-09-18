// FUNNEL PERIOD (2026-09-18, Funnel Analytics FAZA 2) — teste REALE (nu statice) pentru
// lib/funnel-period.js, care e logica PURA (fara DB/Date.now()) — poate fi rulata direct, ca orice
// modul Node normal. Acopera EXACT cerintele explicite ale utilizatorului: granite de luna, granite
// de saptamana (inclusiv o saptamana care se intinde pe doua luni calendaristice diferite), o zi cu
// tranzitie DST reala in UK (2026-03-29, ceasurile inainte), interval custom, si validare stricta
// a input-ului (fara nicio presupunere silentioasa la un query param invalid).
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePeriodBounds, listDaysInRange, addDays, isoMondayOf } = require('../lib/funnel-period');

test('month: ianuarie 2026 -> [2026-01-01, 2026-02-01)', () => {
  assert.deepEqual(resolvePeriodBounds({ type: 'month', year: 2026, month: 1 }), { startDate: '2026-01-01', endDateExclusive: '2026-02-01' });
});

test('month: decembrie -> ianuarie anul urmator (granita de an)', () => {
  assert.deepEqual(resolvePeriodBounds({ type: 'month', year: 2026, month: 12 }), { startDate: '2026-12-01', endDateExclusive: '2027-01-01' });
});

test('month: februarie intr-un an nebisect (2026) -> se termina pe 1 martie (28 zile)', () => {
  const { startDate, endDateExclusive } = resolvePeriodBounds({ type: 'month', year: 2026, month: 2 });
  assert.equal(startDate, '2026-02-01');
  assert.equal(endDateExclusive, '2026-03-01');
});

test('month: an invalid/luna invalida -> arunca eroare, niciodata o presupunere silentioasa', () => {
  assert.throws(() => resolvePeriodBounds({ type: 'month', year: 2026, month: 13 }));
  assert.throws(() => resolvePeriodBounds({ type: 'month', year: 2026, month: 0 }));
  assert.throws(() => resolvePeriodBounds({ type: 'month', year: NaN, month: 5 }));
});

test('week: saptamana ISO (Luni-Duminica) care se intinde pe DOUA luni diferite (31 aug - 6 sep 2026)', () => {
  // 2026-08-31 e Luni (verificat manual) — saptamana trebuie sa acopere exact 31 aug -> 7 sep exclusiv.
  const { startDate, endDateExclusive } = resolvePeriodBounds({ type: 'week', anchorDate: '2026-09-03' });
  assert.equal(startDate, '2026-08-31');
  assert.equal(endDateExclusive, '2026-09-07');
});

test('week: ancora pe Duminica -> saptamana ei incepe cu Lunea DINAINTE (nu cu Lunea urmatoare)', () => {
  const { startDate } = resolvePeriodBounds({ type: 'week', anchorDate: '2026-09-06' }); // Duminica
  assert.equal(startDate, '2026-08-31');
});

test('week: ancora chiar pe Luni -> saptamana incepe cu ACEEASI zi', () => {
  const { startDate } = resolvePeriodBounds({ type: 'week', anchorDate: '2026-09-14' });
  assert.equal(startDate, '2026-09-14');
});

test('day: 2026-03-29 (ziua tranzitiei DST in UK, ceasurile inainte la 01:00) -> tot o singura zi calendaristica, fara nicio ora "pierduta" la nivel de data', () => {
  assert.deepEqual(resolvePeriodBounds({ type: 'day', date: '2026-03-29' }), { startDate: '2026-03-29', endDateExclusive: '2026-03-30' });
});

test('day: data invalida -> arunca eroare', () => {
  assert.throws(() => resolvePeriodBounds({ type: 'day', date: '29-03-2026' }));
  assert.throws(() => resolvePeriodBounds({ type: 'day', date: '' }));
});

test('custom: interval normal, capatul din urma exclusiv = ziua urmatoare lui endDate', () => {
  assert.deepEqual(
    resolvePeriodBounds({ type: 'custom', startDate: '2026-01-25', endDate: '2026-02-03' }),
    { startDate: '2026-01-25', endDateExclusive: '2026-02-04' }
  );
});

test('custom: endDate inainte de startDate -> arunca eroare, niciodata un interval inversat silentios', () => {
  assert.throws(() => resolvePeriodBounds({ type: 'custom', startDate: '2026-02-03', endDate: '2026-01-25' }));
});

test('custom: aceeasi zi ca start si end -> interval de exact o zi', () => {
  assert.deepEqual(
    resolvePeriodBounds({ type: 'custom', startDate: '2026-05-01', endDate: '2026-05-01' }),
    { startDate: '2026-05-01', endDateExclusive: '2026-05-02' }
  );
});

test('type necunoscut -> arunca eroare explicita', () => {
  assert.throws(() => resolvePeriodBounds({ type: 'quarter' }));
  assert.throws(() => resolvePeriodBounds(null));
});

test('listDaysInRange: umple TOATE zilele din interval, capatul din urma exclusiv, niciun gol', () => {
  assert.deepEqual(listDaysInRange('2026-01-30', '2026-02-02'), ['2026-01-30', '2026-01-31', '2026-02-01']);
});

test('listDaysInRange: interval de o singura zi -> un singur element', () => {
  assert.deepEqual(listDaysInRange('2026-06-10', '2026-06-11'), ['2026-06-10']);
});

test('addDays: trece corect granita de an (31 dec -> 1 ian anul urmator)', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('addDays: scadere (zile negative) functioneaza identic', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('isoMondayOf: coerent cu week bounds de mai sus pentru toate cele 7 zile ale aceleiasi saptamani', () => {
  const days = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];
  days.forEach((d) => assert.equal(isoMondayOf(d), '2026-09-14', `${d} trebuie sa apartina saptamanii care incepe 2026-09-14`));
});
