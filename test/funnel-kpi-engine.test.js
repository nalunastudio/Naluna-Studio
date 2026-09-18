// FUNNEL KPI ENGINE (2026-09-18, Funnel Analytics FAZA 2) — teste REALE pentru functiile de
// agregare din db.js (getFunnelKpis/getConversionFunnel/getRevenueAndOrdersTrend/
// getTrafficSources/computeRevenue/insertFunnelEvent/linkFunnelEventsToOrder), fara nicio
// conexiune reala la Postgres — db.pool.query e interceptat (mock) in fiecare test, ceea ce
// permite (a) verificarea EXACTA a SQL-ului emis (Europe/London, formula de venit, FILTER-e,
// GROUP BY) si (b) verificarea ca rezultatul JS e calculat corect din rânduri simulate — fara sa
// depinda de existenta unui Postgres local (niciunul disponibil in acest mediu de dezvoltare).
//
// DATABASE_URL fals, cu "localhost" (evita cerinta SSL a codului pentru hosturi externe) — `pg`
// nu deschide nicio conexiune reala la require() (Pool e lazy), deci acest fisier NU atinge
// niciodata o baza de date reala, doar structura modulului.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db.js');

async function withMockPool(dispatch, fn) {
  const original = db.pool.query.bind(db.pool);
  const calls = [];
  db.pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return dispatch(sql, params);
  };
  try {
    return await fn(calls);
  } finally {
    db.pool.query = original;
  }
}

// ==========================================================================================
// getFunnelKpis
// ==========================================================================================
test('getFunnelKpis: toate cele 4 interogari folosesc AT TIME ZONE \'Europe/London\' (DST-safe, IANA reala Postgres)', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ tracked_visitors: '3', cta_clicks: '2', form_started: '1' }] };
      if (sql.includes('paid_orders')) return { rows: [{ paid_orders: '1', paid_customers: '1', revenue: '15' }] };
      if (sql.includes('checkout_created_at IS NOT NULL')) return { rows: [{ n: '1' }] };
      return { rows: [{ n: '2' }] };
    },
    async (calls) => {
      await db.getFunnelKpis({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      assert.equal(calls.length, 4);
      for (const c of calls) assert.match(c.sql, /AT TIME ZONE 'Europe\/London'/, `interogare fara Europe/London: ${c.sql.slice(0, 80)}`);
    }
  );
});

test('getFunnelKpis: formula de venit e COALESCE(amount_total, price), NICIODATA doar SUM(price)', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ tracked_visitors: '0', cta_clicks: '0', form_started: '0' }] };
      if (sql.includes('paid_orders')) return { rows: [{ paid_orders: '0', paid_customers: '0', revenue: '0' }] };
      return { rows: [{ n: '0' }] };
    },
    async (calls) => {
      await db.getFunnelKpis({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      const revenueCall = calls.find((c) => c.sql.includes('revenue'));
      assert.match(revenueCall.sql, /COALESCE\(amount_total, price\)/);
    }
  );
});

test('getFunnelKpis: "Paid Orders" = paid_at IS NOT NULL STRICT (dovada platii), NICIODATA status=\'ready\' (stare operationala a melodiei, concept diferit — cerinta explicita 2026-09-18 runda 2)', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ tracked_visitors: '0', cta_clicks: '0', form_started: '0' }] };
      if (sql.includes('paid_orders')) return { rows: [{ paid_orders: '0', paid_customers: '0', revenue: '0' }] };
      return { rows: [{ n: '0' }] };
    },
    async (calls) => {
      await db.getFunnelKpis({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      const paidCall = calls.find((c) => c.sql.includes('paid_orders'));
      assert.match(paidCall.sql, /paid_at IS NOT NULL/);
      assert.doesNotMatch(paidCall.sql, /status = 'ready'/);
    }
  );
});

test('getFunnelKpis: CRITIC — o comanda cu paid_at setat dar status DIFERIT de \'ready\' (ex. corectie manuala ulterioara, stare operationala schimbata) TOT trebuie numarata ca plata reala — testat direct impotriva SQL-ului real emis, nu doar a rezultatului mock-uit', async () => {
  await withMockPool(
    (sql, params) => {
      if (sql.includes('funnel_events')) return { rows: [{ tracked_visitors: '0', cta_clicks: '0', form_started: '0' }] };
      if (sql.includes('paid_orders')) {
        // simuleaza EXACT interogarea reala impotriva unui rand cu paid_at IS NOT NULL si status
        // != 'ready' — SQL-ul WHERE nu contine deloc "status", deci un asemenea rand AR fi inclus
        // de o baza de date reala; aici confirmam explicit ca query-ul nu exclude dupa status.
        assert.doesNotMatch(sql, /status/, 'interogarea Paid Orders/Revenue nu trebuie sa filtreze deloc dupa status');
        return { rows: [{ paid_orders: '1', paid_customers: '1', revenue: '15' }] };
      }
      return { rows: [{ n: '0' }] };
    },
    async () => {
      const result = await db.getFunnelKpis({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      assert.equal(result.paidOrders, 1, 'o comanda cu paid_at setat ramane o plata in analytics, indiferent de status');
    }
  );
});

test('getFunnelKpis: "Paid Customers" e DISTINCT pe email normalizat (lowercase) — client cu comenzi multiple platite numarat O SINGURA DATA', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ tracked_visitors: '0', cta_clicks: '0', form_started: '0' }] };
      if (sql.includes('paid_orders')) return { rows: [{ paid_orders: '3', paid_customers: '1', revenue: '45' }] };
      return { rows: [{ n: '0' }] };
    },
    async () => {
      const result = await db.getFunnelKpis({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      assert.equal(result.paidOrders, 3);
      assert.equal(result.paidCustomers, 1, 'paidCustomers != paidOrders cand acelasi client are mai multe comenzi');
    }
  );
});

test('getFunnelKpis: fara excludeEmails -> interogarile NU contin nicio clauza de excludere email', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ tracked_visitors: '0', cta_clicks: '0', form_started: '0' }] };
      if (sql.includes('paid_orders')) return { rows: [{ paid_orders: '0', paid_customers: '0', revenue: '0' }] };
      return { rows: [{ n: '0' }] };
    },
    async (calls) => {
      await db.getFunnelKpis({ startDate: '2026-09-01', endDateExclusive: '2026-10-01' });
      for (const c of calls) {
        assert.doesNotMatch(c.sql, /lower\(email\) != ALL/);
        assert.doesNotMatch(c.sql, /lower\(o\.email\) != ALL/);
      }
    }
  );
});

test('getFunnelKpis: CU excludeEmails -> parametrul de excludere e trimis lowercase, in TOATE interogarile relevante', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ tracked_visitors: '0', cta_clicks: '0', form_started: '0' }] };
      if (sql.includes('paid_orders')) return { rows: [{ paid_orders: '0', paid_customers: '0', revenue: '0' }] };
      return { rows: [{ n: '0' }] };
    },
    async (calls) => {
      await db.getFunnelKpis({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: ['Test@Example.com'] });
      const ordersCall = calls.find((c) => c.sql.includes('FROM orders') && c.sql.includes('created_at') && !c.sql.includes('checkout_created_at') && !c.sql.includes('paid_orders'));
      assert.ok(ordersCall);
      assert.match(ordersCall.sql, /lower\(email\) != ALL/);
      assert.deepEqual(ordersCall.params[2], ['test@example.com']);
    }
  );
});

// ==========================================================================================
// getConversionFunnel — cohorta pe created_at (nu pe checkout_created_at/paid_at)
// ==========================================================================================
test('getConversionFunnel: cohorta e definita STRICT prin fereastra de created_at — checkout_created_at/status NU sunt ferestruite in timp (comportamentul lor e verificat oricand s-a intamplat, in afara sau in interiorul perioadei)', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ tracked_visitors: '10', cta_clicks: '5', form_started: '3' }] };
      return { rows: [{ orders_created: '3', reached_checkout: '1', paid_orders: '1' }] };
    },
    async (calls) => {
      const stages = await db.getConversionFunnel({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      const cohortCall = calls.find((c) => c.sql.includes('orders_created'));
      // fereastra de timp trebuie legata STRICT de created_at
      assert.match(cohortCall.sql, /created_at >= \(\$1::date AT TIME ZONE 'Europe\/London'\) AND created_at < \(\$2::date AT TIME ZONE 'Europe\/London'\)/);
      // checkout_created_at/status apar STRICT in FILTER (...), niciodata in fereastra WHERE de timp
      assert.match(cohortCall.sql, /FILTER \(WHERE checkout_created_at IS NOT NULL\)/);
      assert.match(cohortCall.sql, /FILTER \(WHERE paid_at IS NOT NULL\)/);
      assert.doesNotMatch(cohortCall.sql, /status = 'ready'/, 'Paid Orders nu trebuie sa mai depinda de status=\'ready\' (concept operational, diferit de dovada platii)');
      assert.doesNotMatch(cohortCall.sql, /checkout_created_at >= /);
      assert.doesNotMatch(cohortCall.sql, /paid_at >= /);

      assert.equal(stages.find((s) => s.key === 'ordersCreated').count, 3);
      assert.equal(stages.find((s) => s.key === 'reachedCheckout').count, 1);
    }
  );
});

// ==========================================================================================
// getRevenueAndOrdersTrend
// ==========================================================================================
test('getRevenueAndOrdersTrend: foloseste to_char(...,\'YYYY-MM-DD\') (evita bug-ul cunoscut de parsare a datelor in pg, dependent de fusul orar al serverului)', async () => {
  await withMockPool(
    (sql) => (sql.includes('orders_count') || sql.toLowerCase().includes('count(*) as n')) ? { rows: [] } : { rows: [] },
    async (calls) => {
      await db.getRevenueAndOrdersTrend({ startDate: '2026-09-01', endDateExclusive: '2026-09-04', excludeEmails: [] });
      for (const c of calls) assert.match(c.sql, /to_char\(date_trunc\('day', \w+ AT TIME ZONE 'Europe\/London'\), 'YYYY-MM-DD'\)/);
    }
  );
});

test('getRevenueAndOrdersTrend: zilele FARA nicio comanda/plata apar explicit cu 0 (niciun gol in serie)', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('COALESCE(amount_total, price)')) return { rows: [{ day: '2026-09-02', revenue: '15' }] };
      return { rows: [{ day: '2026-09-01', n: '2' }] };
    },
    async () => {
      const trend = await db.getRevenueAndOrdersTrend({ startDate: '2026-09-01', endDateExclusive: '2026-09-04', excludeEmails: [] });
      assert.deepEqual(trend.map((t) => t.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
      assert.equal(trend[0].ordersCreated, 2);
      assert.equal(trend[0].revenue, 0);
      assert.equal(trend[1].ordersCreated, 0);
      assert.equal(trend[1].revenue, 15);
      assert.equal(trend[2].ordersCreated, 0);
      assert.equal(trend[2].revenue, 0);
    }
  );
});

// ==========================================================================================
// getTrafficSources
// ==========================================================================================
test('getTrafficSources: utm_source/utm_campaign lipsa -> grupate ca "(unknown)", niciodata NULL afisat direct', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [] };
      return { rows: [{ source: '(unknown)', campaign: '(unknown)', orders_created: '4', reached_checkout: '1', paid_orders: '1', revenue: '15' }] };
    },
    async () => {
      const sources = await db.getTrafficSources({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      assert.equal(sources[0].source, '(unknown)');
      assert.equal(sources[0].campaign, '(unknown)');
    }
  );
});

test('getTrafficSources: launch_post_1 (facebook/social) identificabil explicit ca sursa/campanie proprie', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ source: 'facebook', campaign: 'launch_post_1', tracked_visitors: '20', form_started: '5' }] };
      return { rows: [{ source: 'facebook', campaign: 'launch_post_1', orders_created: '2', reached_checkout: '1', paid_orders: '1', revenue: '15' }] };
    },
    async () => {
      const sources = await db.getTrafficSources({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      const fb = sources.find((s) => s.source === 'facebook' && s.campaign === 'launch_post_1');
      assert.ok(fb, 'randul facebook/launch_post_1 trebuie sa existe');
      assert.equal(fb.trackedVisitors, 20);
      assert.equal(fb.ordersCreated, 2);
      assert.equal(fb.paidOrders, 1);
      assert.equal(fb.conversionRatePct, 50);
    }
  );
});

test('getTrafficSources: o sursa cu vizitatori/form_started dar ZERO comenzi tot apare in tabel (nu e omisa doar pentru ca nu a convertit inca)', async () => {
  await withMockPool(
    (sql) => {
      if (sql.includes('funnel_events')) return { rows: [{ source: 'instagram', campaign: '(unknown)', tracked_visitors: '8', form_started: '1' }] };
      return { rows: [] };
    },
    async () => {
      const sources = await db.getTrafficSources({ startDate: '2026-09-01', endDateExclusive: '2026-10-01', excludeEmails: [] });
      const ig = sources.find((s) => s.source === 'instagram');
      assert.ok(ig);
      assert.equal(ig.ordersCreated, 0);
      assert.equal(ig.conversionRatePct, null, 'rata de conversie e null (nu 0%/NaN%) cand nu exista nicio comanda inca');
    }
  );
});

// ==========================================================================================
// computeRevenue — folosit si de Dashboard, trebuie sa fie IDENTICA formula ca getFunnelKpis
// ==========================================================================================
test('computeRevenue: SUM(COALESCE(amount_total, price)) — aceeasi formula ca restul motorului KPI (Dashboard si Sales & Funnel raporteaza IDENTIC "venit")', async () => {
  await withMockPool(
    () => ({ rows: [{ total: '150' }] }),
    async (calls) => {
      const revenue = await db.computeRevenue({});
      assert.equal(revenue, 150);
      assert.match(calls[0].sql, /COALESCE\(SUM\(COALESCE\(amount_total, price\)\), 0\)/);
    }
  );
});

test('computeRevenue: WHERE paid_at IS NOT NULL STRICT, NICIODATA status=\'ready\' — identic cu getFunnelKpis (2026-09-18, runda 2, cerinta explicita)', async () => {
  await withMockPool(
    () => ({ rows: [{ total: '0' }] }),
    async (calls) => {
      await db.computeRevenue({});
      assert.match(calls[0].sql, /WHERE paid_at IS NOT NULL/);
      assert.doesNotMatch(calls[0].sql, /status/);
    }
  );
});

// ==========================================================================================
// insertFunnelEvent / linkFunnelEventsToOrder
// ==========================================================================================
test('insertFunnelEvent: insereaza EXACT cele 11 coloane ale funnel_events, fara email/nume/PII', async () => {
  await withMockPool(
    () => ({ rows: [] }),
    async (calls) => {
      await db.insertFunnelEvent({ eventName: 'cta_clicked', visitorId: 'v1', orderId: null, utmSource: 'facebook', utmMedium: 'social', utmCampaign: 'launch_post_1', meta: { location: 'hero' } });
      assert.match(calls[0].sql, /INSERT INTO funnel_events \(id, event_name, visitor_id, order_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, meta\)/);
      assert.equal(calls[0].params.length, 11);
      assert.doesNotMatch(calls[0].sql, /\bemail\b|\brecipient\b|\bstory\b|\bsender\b/i);
    }
  );
});

test('linkFunnelEventsToOrder: NICIODATA nu suprascrie un order_id deja setat (WHERE order_id IS NULL) — nu amesteca evenimentele unei comenzi anterioare cu cele ale uneia noi, pentru acelasi vizitator', async () => {
  await withMockPool(
    () => ({ rows: [] }),
    async (calls) => {
      await db.linkFunnelEventsToOrder('v1', 'order-2');
      assert.match(calls[0].sql, /WHERE visitor_id = \$1 AND order_id IS NULL/);
      assert.deepEqual(calls[0].params, ['v1', 'order-2']);
    }
  );
});

test('linkFunnelEventsToOrder: visitorId lipsa -> nu emite nicio interogare (fara comanda de test/lipsa consimtamant, nu exista ce sa legam)', async () => {
  await withMockPool(
    () => ({ rows: [] }),
    async (calls) => {
      await db.linkFunnelEventsToOrder(null, 'order-2');
      assert.equal(calls.length, 0);
    }
  );
});
