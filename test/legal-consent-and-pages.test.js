// LAUNCH SAFETY (2026-09-02, Faza 2 — Legal: checkout consent, durable confirmation, pagini
// legale) + Faza 5 (retention/deletion). Verifica STRUCTURAL toate piesele noi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
function extractFn(source, signature) {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `nu am gasit "${signature}"`);
  let depth = 1, i = idx + signature.length;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  return source.slice(idx, i + 1);
}

const server = read('server.js');
const db = read('db.js');
const melodia = read('public/melodia-mea.html');

// ---------------------------------------------------------------------------------------------
// Pagini legale
// ---------------------------------------------------------------------------------------------
for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
  test(`public/${page}: exista, contine adresa reala si contact@nalunastudio.com, fara [DE COMPLETAT]`, () => {
    const html = read(`public/${page}`);
    assert.ok(html.includes('5 Brayford Square'));
    assert.ok(html.includes('contact@nalunastudio.com'));
    assert.ok(!html.includes('DE COMPLETAT'), `${page} nu trebuie sa mai contina placeholder-e necompletate`);
    assert.ok(!/\[.*TBD.*\]/i.test(html));
  });
}

test('terms.html: dezvaluirea numelui proprietarului (Natalia Andoni, cerinta CA2006 s.1201) apare STRICT in interiorul entity-box, ca text simplu — fara heading, bold sau evidentiere separata', () => {
  const html = read('public/terms.html');
  const idx = html.indexOf('Natalia Andoni');
  assert.notEqual(idx, -1, 'terms.html trebuie sa dezvaluie numele proprietarului (cerinta legala CA2006 s.1201)');
  const boxStart = html.indexOf('class="entity-box"');
  const boxEnd = html.indexOf('</div>', boxStart);
  assert.ok(idx > boxStart && idx < boxEnd, 'numele trebuie sa fie in interiorul entity-box, alaturi de restul informatiilor legale ale firmei');
  const boxContent = html.slice(boxStart, boxEnd);
  assert.ok(!/<(h1|h2|h3|h4|h5|h6|strong|b)[ >]/i.test(boxContent), 'entity-box nu trebuie sa contina niciun heading/bold — text simplu, ca restul continutului legal');
});

// ---------------------------------------------------------------------------------------------
// Audit traducere automata (2026-09-06, runda 5) — toate cele 3 pagini legale, toate aparitiile
// "Naluna Studio"/"Natalia Andoni". Cauza radacina reala (confirmata pe 2 exemple live gasite de
// utilizator — "deNaluna Studio" si "Naluna Studiocreeaza"): Google Translate/traducerea nativa
// Chrome trateaza fiecare span notranslate ca un bloc opac si RETRADUCE separat textul din jur;
// motoarele de traducere elimina de regula spatiile de la marginea unui segment tradus (leading/
// trailing trim). Un spatiu care sta IN AFARA span-ului notranslate, la granita cu acesta, e deci
// mereu in pericol sa fie sters — indiferent daca span-ul e la inceputul sau la sfarsitul
// segmentului tradus. Solutia ROBUSTA (ceruta explicit — nu spatii fragile) e sa mutam spatiul
// de granita IN INTERIORUL span-ului notranslate, pe partea unde atinge text traductibil —
// continutul notranslate e copiat neschimbat, niciodata trecut prin trim-ul motorului de
// traducere. Aplicata simetric: spatiu la INCEPUTUL span-ului daca text traductibil il precede,
// spatiu la SFARSITUL span-ului daca text traductibil il urmeaza.
const NOTRANSLATE_BRAND_SITES = {
  'terms.html': [
    // entity-box: "Naluna Studio" izolat pe propriul rand (intre <br>-uri) — fara risc de
    // adiacenta, span simplu, fara spatiu suplimentar necesar.
    { pattern: /<span translate="no" class="notranslate">Naluna Studio<\/span><br>/, desc: 'entity-box: Naluna Studio' },
    // entity-box: precedat de "Operated by" (text traductibil) — spatiul de granita STANGA
    // mutat in interiorul span-ului.
    { pattern: /Operated by<span translate="no" class="notranslate"> Natalia Andoni<\/span><br>/, desc: 'entity-box: Operated by Natalia Andoni' },
    // Sectiunea 1: precedat de "operated by" — acelasi tipar, spatiu STANGA mutat inauntru;
    // dupa span urmeaza STRICT o virgula (punctuatie, nu spatiu) — fara risc pe partea dreapta.
    { pattern: /operated by<span translate="no" class="notranslate"> Naluna Studio<\/span>, trading/, desc: 'Sectiunea 1: operated by Naluna Studio,' },
    // Sectiunea 2: urmat de "creates" (text traductibil) — spatiul de granita DREAPTA mutat in
    // interiorul span-ului; span-ul e la inceputul paragrafului, fara text inainte.
    { pattern: /<span translate="no" class="notranslate">Naluna Studio <\/span>creates personalised/, desc: 'Sectiunea 2: Naluna Studio creates' }
  ],
  'privacy.html': [
    { pattern: /<span translate="no" class="notranslate">Naluna Studio<\/span><br>/, desc: 'entity-box: Naluna Studio' },
    // ambele aparitii din Sectiunea 1 au text traductibil PE AMBELE PARTI — spatiu mutat
    // inauntru pe AMBELE laturi ale span-ului.
    { pattern: /personal data<span translate="no" class="notranslate"> Naluna Studio <\/span>collects/, desc: 'Sectiunea 1: personal data Naluna Studio collects' },
    { pattern: /with it\.<span translate="no" class="notranslate"> Naluna Studio <\/span>decides/, desc: 'Sectiunea 1: with it. Naluna Studio decides' }
  ],
  'refund.html': [
    { pattern: /<span translate="no" class="notranslate">Naluna Studio<\/span><br>/, desc: 'entity-box: Naluna Studio' }
  ]
};

for (const [page, sites] of Object.entries(NOTRANSLATE_BRAND_SITES)) {
  test(`${page}: TOATE aparitiile "Naluna Studio"/"Natalia Andoni" sunt protejate translate="no"+notranslate, cu spatiul de granita MUTAT in interiorul span-ului pe partea unde atinge text traductibil (fix robust, nu spatii fragile) — verificat exact per aparitie`, () => {
    const html = read(`public/${page}`);
    for (const { pattern, desc } of sites) {
      assert.match(html, pattern, `${page} — lipseste sau e incorect formatul asteptat pentru: ${desc}`);
    }
    const brandOccurrences = (html.match(/Naluna Studio/g) || []).length;
    const expectedBrandSites = sites.filter(s => s.desc.includes('Naluna Studio')).length;
    assert.equal(brandOccurrences, expectedBrandSites, `${page}: numarul de aparitii "Naluna Studio" (${brandOccurrences}) nu corespunde cu numarul de situri verificate (${expectedBrandSites}) — a aparut sau a disparut o aparitie neverificata`);
    const nameOccurrences = (html.match(/Natalia Andoni/g) || []).length;
    const expectedNameSites = sites.filter(s => s.desc.includes('Natalia Andoni')).length;
    assert.equal(nameOccurrences, expectedNameSites, `${page}: numarul de aparitii "Natalia Andoni" (${nameOccurrences}) nu corespunde cu numarul de situri verificate (${expectedNameSites})`);
  });
}

test('Regresie reala (2026-09-06): NICIUN text traductibil nu mai atinge direct un span notranslate FARA spatiu de granita in interior — tiparele exacte "deNaluna Studio"/"deNatalia Andoni"/"Naluna Studiocreeaza" (raportate live de utilizator, engleza sursa: "by<span...>", "<span...>creates") sunt structural imposibile acum, nu doar absente intamplator', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    // niciun span notranslate nu incepe/se termina cu textul brandului FARA spatiul de granita
    // acolo unde e nevoie — verificat prin absenta explicita a variantelor gresite posibile.
    assert.ok(!/[a-zA-Z]<span translate="no" class="notranslate">Naluna Studio<\/span>[a-zA-Z]/.test(html), `${page}: niciun span notranslate nu trebuie lipit direct de litere pe ambele parti fara spatiu de granita mutat inauntru`);
    assert.ok(!html.includes(' <span translate="no" class="notranslate">Naluna Studio</span>creat'), `${page}: verificare explicita a tiparului de bug raportat`);
  }
});

test('terms.html/privacy.html/refund.html: pagina engleza ramane vizual neschimbata — span-urile notranslate sunt inline, fara CSS nou, fara sa rupa structura entity-box sau layout-ul <br>', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(!html.includes('.notranslate{'), `${page}: notranslate e STRICT un hook semantic pentru Google Translate, nu are nevoie de stil CSS propriu`);
  }
  const termsHtml = read('public/terms.html');
  const boxStart = termsHtml.indexOf('class="entity-box"');
  const boxEnd = termsHtml.indexOf('</div>', boxStart);
  const boxContent = termsHtml.slice(boxStart, boxEnd);
  assert.equal((boxContent.match(/<br>/g) || []).length, 6, 'structura pe linii a entity-box din terms.html (6 <br>) trebuie sa ramana neschimbata');
});

test('Stripe, adresele de email si domeniul nalunastudio.com raman NEATINSE (fara translate="no") — nicio dovada de risc real de traducere gresita, motoarele de traducere le recunosc deja ca token-uri netraductibile; adaugarea unor marcaje inutile ar fi complicat implementarea fara beneficiu demonstrat', () => {
  const privacy = read('public/privacy.html');
  const idx = privacy.indexOf('Stripe');
  assert.notEqual(idx, -1);
  assert.ok(!privacy.slice(Math.max(0, idx - 60), idx + 60).includes('translate="no"'), 'Stripe nu are nevoie de protectie — nicio dovada de risc');
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(!/translate="no"[^>]*>contact@nalunastudio\.com/.test(html) && !/translate="no"[^>]*>nalunastudio\.com/.test(html), `${page}: emailul/domeniul nu au nevoie de protectie separata`);
  }
});

test('terms.html: identitatea foloseste acum "Operated by Natalia Andoni" (reformulare eleganta 2026-09-06, runda 3) — "trading name of" a disparut COMPLET din tot codul; baza legala (E-Commerce Regs 2002 reg.6 + CA2006 s.1201) nu impune acea fraza exacta, doar prezenta numelui/adresei/contactului', () => {
  const html = read('public/terms.html');
  assert.match(html, /Operated by.*Natalia Andoni/s);
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const pageHtml = read(`public/${page}`);
    assert.ok(!pageHtml.includes('trading name of'), `${page} nu trebuie sa mai contina "trading name of"`);
  }
  assert.ok(!server.includes('trading name of') && !db.includes('trading name of'));
});

test('numele personal (Natalia Andoni) NU apare NICAIERI altundeva in site (alte pagini publice, server.js/db.js, emailuri, footere, metadate) — vizibilitate STRICT minima, doar in terms.html', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html') && f !== 'terms.html');
  for (const file of htmlFiles) {
    const html = read(`public/${file}`);
    assert.ok(!html.includes('Natalia Andoni'), `${file} NU trebuie sa contina numele personal al proprietarului`);
    assert.ok(!html.includes('Andoni'), `${file} NU trebuie sa contina numele de familie al proprietarului`);
  }
  assert.ok(!server.includes('Natalia Andoni') && !server.includes('Andoni'), 'server.js (inclusiv emailurile de livrare) nu trebuie sa contina numele personal');
  assert.ok(!db.includes('Natalia Andoni') && !db.includes('Andoni'), 'db.js nu trebuie sa contina numele personal');
});

test('refund.html si terms.html: NU exista niciun termen general de "14 zile" impus pentru RECLAMAREA unui defect — nu e cerut legal (CRA 2015 nu impune un astfel de termen, doar termenul de plata a rambursarii dupa acceptare)', () => {
  const refund = read('public/refund.html');
  const terms = read('public/terms.html');
  assert.ok(!/within 14 days of delivery/i.test(refund), 'refund.html nu trebuie sa impuna un termen de 14 zile pentru raportarea unui defect');
  assert.ok(!/within 14 days of delivery/i.test(terms));
  assert.ok(/within 14 days.*(agree|agreeing)/i.test(refund), 'refund.html poate mentiona 14 zile STRICT ca termen de PLATA a rambursarii dupa ce a fost acceptata (cerinta reala CRA 2015 s.44/45)');
});

test('refund.html si terms.html: NU exista rambursare voluntara doar pentru schimbarea parerii/nu-mi place rezultatul, dupa livrare', () => {
  for (const page of ['refund.html', 'terms.html']) {
    const html = read(`public/${page}`);
    assert.ok(/not entitled to a (voluntary )?refund/i.test(html), `${page} trebuie sa afirme explicit ca nu exista rambursare pentru schimbarea parerii`);
    assert.ok(/change (your|my) mind/i.test(html) || /change of mind/i.test(html));
  }
});

test('refund.html si terms.html: rambursare GARANTATA daca Naluna esueaza sa livreze din cauza unui defect tehnic/de sistem propriu si nu poate fi remediat rezonabil', () => {
  for (const page of ['refund.html', 'terms.html']) {
    const html = read(`public/${page}`);
    assert.ok(/technical or system failure/i.test(html), `${page} trebuie sa promita rambursare pentru esec tehnic/de sistem propriu`);
    assert.ok(/refund what you paid/i.test(html) || /refund (in full|the full price)/i.test(html));
  }
});

test('refund.html si terms.html: drepturile STATUTARE (CRA 2015) pentru continut defect/neconform/nelivrat sunt pastrate — reparare/inlocuire, apoi reducere de pret pana la 100%, fara excludere', () => {
  for (const page of ['refund.html', 'terms.html']) {
    const html = read(`public/${page}`);
    assert.ok(/repair.*or.*(correct|replacement)|repair or correct/i.test(html), `${page} trebuie sa mentioneze dreptul la reparare/inlocuire`);
    assert.ok(/price reduction/i.test(html), `${page} trebuie sa mentioneze reducerea de pret`);
    assert.ok(/full price/i.test(html), `${page} trebuie sa clarifice ca reducerea poate ajunge la pretul integral`);
    assert.ok(/cannot be excluded|cannot exclude/i.test(html), `${page} trebuie sa clarifice ca aceste drepturi statutare nu pot fi excluse`);
  }
});

test('server.js: toate cele 8 limbi ale CONSENT_TOS_TEXT includ clauza "nu exista rambursare pentru schimbarea parerii", pastrand neafectate drepturile pentru continut defect/nelivrat din vina Naluna — CORECȚIE 2026-09-11: consimțământul nu mai trăiește ca text în melodia-mea.html, ci ca custom_text nativ Stripe (CONSENT_TOS_TEXT), pentru ca bara veche apărea pe toată durata ascultării/editării, nu doar chiar înaintea plății', () => {
  const matches = server.match(/^  [a-z]{2}: `/gm) || [];
  assert.ok(server.includes('const CONSENT_TOS_TEXT = {'), 'trebuie sa existe harta CONSENT_TOS_TEXT');
  const tosBlock = extractFn(server, 'const CONSENT_TOS_TEXT = {');
  const langCount = (tosBlock.match(/^  [a-z]{2}: `/gm) || []).length;
  assert.equal(langCount, 8, 'trebuie sa existe exact 8 intrari CONSENT_TOS_TEXT (una per limba)');
  const faultMarkers = ["fault on Naluna's side", 'din vina Naluna', 'eines Fehlers von Naluna', 'un fallo de Naluna', 'un errore di Naluna', 'défaillance de Naluna', 'грешка на Naluna', 'Naluna kaynaklı bir hata'];
  for (const marker of faultMarkers) {
    assert.ok(tosBlock.includes(marker), `lipseste mentiunea drepturilor pastrate pentru esecul din vina Naluna: "${marker}"`);
  }
  // Fiecare intrare trebuie sa fie sub limita reala Stripe de 1200 caractere pentru custom_text
  // (verificat direct din documentatia oficiala) — chiar si dupa expandarea ${DOMAIN}.
  const fakeDomain = 'https://nalunastudio.com';
  for (const m of tosBlock.matchAll(/^  [a-z]{2}: `([^`]*)`,?$/gm)) {
    const expanded = m[1].replace(/\$\{DOMAIN\}/g, fakeDomain);
    assert.ok(expanded.length <= 1200, `text CONSENT_TOS_TEXT prea lung (${expanded.length} caractere) pentru custom_text Stripe`);
  }
});

// CORECȚIE (2026-09-11, v5->v6): versiunea anterioară a acestui test cerea ca CONSENT_TOS_TEXT
// să afirme "produsul EXISTĂ DEJA" — framing preluat din vechiul consent_text, NEVERIFICAT direct
// contra textului real, live, al terms.html/refund.html. Verificat acum exhaustiv (citire directă
// a paginilor live): refund.html Secțiunea 2 spune explicit "you lose your statutory 14-day right
// to cancel once CREATION has started" și terms.html Secțiunea 3/4 confirmă "Creation begins
// immediately after your payment is confirmed" — deci CONSENT_TOS_TEXT trebuie să reflecte
// EXACT acest declanșator (crearea, nu livrarea), nu presupunerea anterioară. Emailul de livrare
// (piesă de text SEPARATĂ, netouchată de această corecție) rămâne verificat separat, neschimbat.
test('server.js: CONSENT_TOS_TEXT reflectă STRICT declanșatorul real din refund.html/terms.html (crearea, nu livrarea) — "14 zile" păstrat pentru că e explicit real în refund.html Secțiunea 2', () => {
  const tosBlock = extractFn(server, 'const CONSENT_TOS_TEXT = {');
  assert.ok(/begin creating|înceapă imediat crearea|sofort zu erstellen|comience a crear|iniziare subito a creare|commencer immédiatement à créer|започне незабавно да създава|hemen oluşturmaya başlamasını/i.test(tosBlock), 'CONSENT_TOS_TEXT trebuie sa reflecte ca CREAREA incepe la plata, exact ca refund.html/terms.html');
  assert.ok(!/already-created|deja creat,|bereits fertiges|ya creado,|già creato,|déjà créée,|вече готовата|Zaten oluşturulmuş/i.test(tosBlock), 'CONSENT_TOS_TEXT nu mai trebuie sa afirme ca produsul EXISTA DEJA — nu e sustinut de terms.html/refund.html live');
  assert.match(tosBlock, /14[\s-]?(day|zile|tägiges|días|giorni|jours|дни|günlük)/i, '"14 zile" trebuie pastrat — e explicit real, in refund.html Sectiunea 2 ("statutory 14-day right to cancel")');
  const legalNoteFn = extractFn(server, "async function sendDeliveryEmail(order) {");
  assert.ok(!/work on your personalised order would begin|lucrul la comanda ta personalizată să înceapă/i.test(legalNoteFn), 'emailul de livrare nu mai trebuie sa afirme ca "lucrul" incepe la plata');
  assert.match(legalNoteFn, /delivery of your already-created personalised song\/video would begin/, 'emailul de livrare (piesa separata, netouchata aici) trebuie sa reflecte corect ca LIVRAREA incepe, nu crearea');
});

test('Cele 3 pagini legale NU mai contin nicio referinta la "AI"/"artificial intelligence" — EU AI Act art.50 (deepfake) nu se aplica unui cantec personalizat/unui montaj din pozele reale ale clientului, deci nu e o dezvaluire ceruta legal; formularea a fost mutata spre limbaj neutru de produs, fara a pretinde "handmade" sau compus de muzicieni', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(!/\bAI\b/.test(html), `${page} nu trebuie sa mai contina "AI"`);
    assert.ok(!/artificial intelligence/i.test(html), `${page} nu trebuie sa mai contina "artificial intelligence"`);
    assert.ok(!/\b(handmade|hand-made|composed by our|created personally by)\b/i.test(html), `${page} nu trebuie sa introduca o pretentie falsa de creatie umana in locul AI`);
  }
});

test('Privacy Policy: tabelul de destinatari foloseste CATEGORII (nu nume de furnizori tehnici) — permis explicit de UK GDPR art.13(1)(e)/14(1)(e) ("recipients OR categories of recipients") — Stripe ramane numit explicit (motiv real de transparenta despre plati)', () => {
  const html = read('public/privacy.html');
  assert.ok(html.includes('Stripe'), 'Stripe poate ramane numit explicit');
  for (const vendor of ['Our AI music generation provider', 'Resend', 'Cloudflare', 'Railway (hosting']) {
    assert.ok(!html.includes(vendor), `${vendor} nu trebuie sa mai apara — foloseste categoria, nu numele furnizorului tehnic`);
  }
  assert.ok(html.includes('The service that generates your song'));
  assert.ok(html.includes('email delivery provider'));
  assert.ok(html.includes('cloud storage provider'));
  assert.ok(html.includes('hosting provider'));
});

test('Privacy Policy: eticheta "(data controller)" nu mai apare ca element de branding in entity-box — termenul "controller" e explicat natural in corpul textului, informatia de identitate a operatorului ramane intacta', () => {
  const html = read('public/privacy.html');
  assert.ok(!html.includes('(data controller)'), 'eticheta stil-branding trebuie eliminata din entity-box');
  assert.match(html, /makes us the ["']controller["'] of that data/, 'termenul controller trebuie explicat in text, nu doar afisat ca eticheta');
  const boxStart = html.indexOf('class="entity-box"');
  const boxEnd = html.indexOf('</div>', boxStart);
  assert.ok(html.slice(boxStart, boxEnd).includes('5 Brayford Square'), 'identitatea/adresa operatorului trebuie sa ramana in entity-box');
});

test('Cele 3 pagini legale NU mai afiseaza deloc "Last updated"/o data de revizuire, nicaieri (decizie de business 2026-09-06, runda 3 — verificat ca nu exista obligatie legala UK GDPR Art.13/14 care sa ceara asta) — dar clasele CSS orfane (.updated/.footer-updated) au fost curatate, nu doar continutul textual', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(!html.includes('Last updated'), `${page} nu trebuie sa mai contina "Last updated" nicaieri`);
    assert.ok(!html.includes('class="updated"'), `${page} nu trebuie sa mai foloseasca clasa CSS "updated"`);
    assert.ok(!html.includes('footer-updated'), `${page} nu trebuie sa mai contina clasa orfana footer-updated`);
  }
});

test('CONSENT_POLICY_VERSION (versionarea interna, dovada consimtamantului) ramane intacta — eliminarea afisarii publice a "Last updated" NU atinge evidenta interna asociata fiecarei comenzi platite', () => {
  assert.match(server, /const CONSENT_POLICY_VERSION = '2026-09-11-v6';/);
  assert.match(server, /consentPolicyVersion:\s*consentAccepted\s*\?\s*CONSENT_POLICY_VERSION\s*:\s*null/);
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS consent_policy_version TEXT;/);
});

test('Numele "Maria" nu apare niciodata ca identitate a proprietarului/afacerii in paginile legale (poate exista doar ca exemplu generic de nume in alte pagini, ex. placeholder de formular)', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(!html.includes('Maria'), `${page} nu trebuie sa contina "Maria"`);
  }
});

test('Cele 3 pagini legale se leaga reciproc (footer identic pe toate)', () => {
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.ok(html.includes('href="/terms.html"'));
    assert.ok(html.includes('href="/privacy.html"'));
    assert.ok(html.includes('href="/refund.html"'));
  }
});

test('index.html si toate paginile client (comanda/melodia-mea/comanda-mea/succes) leaga cele 3 pagini legale in footer', () => {
  for (const page of ['index.html', 'comanda.html', 'melodia-mea.html', 'comanda-mea.html', 'succes.html']) {
    const html = read(`public/${page}`);
    assert.ok(html.includes('href="/terms.html"'), `${page} lipseste link Terms`);
    assert.ok(html.includes('href="/privacy.html"'), `${page} lipseste link Privacy`);
    assert.ok(html.includes('href="/refund.html"'), `${page} lipseste link Refund`);
    assert.ok(html.includes('contact@nalunastudio.com'), `${page} lipseste emailul de contact`);
    assert.ok(!html.includes('DE COMPLETAT'));
  }
});

// ---------------------------------------------------------------------------------------------
// Checkout consent — Stripe Checkout nativ (CORECȚIE 2026-09-11, Faza 2 v2)
//
// Bara proprie (checkbox + text legal complet) apărea, în varianta veche, ori de câte ori
// checkoutBtn.disabled devenea false — adică pe toată durata ascultării/editării, nu doar chiar
// înaintea plății (checkoutBtn e activ imediat ce o variantă e gata de plată, cu mult înainte ca
// clientul să decidă efectiv să plătească). Mecanismul propriu a fost eliminat complet — bifa e
// acum colectată NATIV de Stripe Checkout, pe pagina de plată găzduită, chiar lângă butonul de
// plată — singurul loc real mai aproape de momentul plății.
// ---------------------------------------------------------------------------------------------
test('server.js: POST /checkout cere consimțământ NATIV Stripe (consent_collection.terms_of_service=required + custom_text.terms_of_service_acceptance), setat pe sesiune INAINTE de a fi trimisă', () => {
  const fn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  assert.match(fn, /consent_collection:\s*\{\s*terms_of_service:\s*'required'\s*\}/);
  assert.match(fn, /custom_text:\s*\{\s*terms_of_service_acceptance:\s*\{\s*message:\s*CONSENT_TOS_TEXT\[order\.lang\]/);
  assert.ok(!fn.includes('consentGiven'), 'vechea validare client-side de consentGiven nu mai trebuie sa existe — Stripe o inlocuieste complet');
});

test('server.js: sesiunea Stripe foloseste locale-ul comenzii, pentru ca textul de consimtamant sa se potriveasca cu limba paginii Stripe', () => {
  const fn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  assert.match(fn, /locale:\s*ALLOWED_LANGS\.includes\(order\.lang\)\s*\?\s*order\.lang\s*:\s*'auto'/);
});

test('server.js: consimtamantul NU se mai scrie la crearea sesiunii (clientul inca nu a bifat nimic la acel moment) — se scrie STRICT la confirmarea reala a platii, in webhook, pe baza session.consent confirmat de Stripe', () => {
  const checkoutFn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  assert.ok(!/consentGivenAt:\s*new Date\(\)/.test(checkoutFn), 'crearea sesiunii nu mai trebuie sa scrie consentGivenAt direct');
  const paymentFn = extractFn(server, 'async function processConfirmedPayment(event, session) {');
  assert.match(paymentFn, /session\.consent\s*&&\s*session\.consent\.terms_of_service\s*===\s*'accepted'/, 'confirmarea platii trebuie sa citeasca dovada REALA de la Stripe, nu doar sa presupuna');
  assert.match(paymentFn, /consentGivenAt:\s*consentAccepted\s*\?\s*new Date\(\)\s*:\s*null/);
  assert.match(paymentFn, /consentPolicyVersion:\s*consentAccepted\s*\?\s*CONSENT_POLICY_VERSION\s*:\s*null/);
});

test('db.js: consent_given_at/consent_policy_version exista in schema, rowToOrder si COLUMN_MAP (schema neschimbata — doar MOMENTUL scrierii s-a mutat)', () => {
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS consent_given_at TIMESTAMPTZ;/);
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS consent_policy_version TEXT;/);
  assert.match(db, /consentGivenAt: row\.consent_given_at \|\| null,/);
  assert.match(db, /consentGivenAt: 'consent_given_at',/);
});

// ---------------------------------------------------------------------------------------------
// Bara veche eliminată complet din melodia-mea.html (rămâne doar dezvăluirea informativă de
// 30 de zile, care NU e o acțiune de bifat, deci poate rămâne vizibilă permanent)
// ---------------------------------------------------------------------------------------------
test('melodia-mea.html: bara/checkbox-ul propriu de consimtamant NU mai exista deloc — inlocuit de mecanismul nativ Stripe', () => {
  assert.ok(!melodia.includes('checkout-consent-bar'), 'bara veche de consimtamant nu mai trebuie sa existe');
  assert.ok(!melodia.includes('checkout-consent-checkbox'), 'checkbox-ul propriu nu mai trebuie sa existe');
  assert.ok(!melodia.includes('checkoutConsentCheckbox'), 'referinta JS catre checkbox-ul propriu nu mai trebuie sa existe');
  assert.ok(!melodia.includes('updateConsentBarVisibility'), 'logica de vizibilitate a barei vechi nu mai trebuie sa existe');
  assert.ok(!melodia.includes('consent_text'), 'textul legal complet nu mai trebuie sa existe in melodia-mea.html (traiaste acum in CONSENT_TOS_TEXT, server.js)');
  assert.ok(!melodia.includes('consent_required_error'), 'mesajul de eroare al vechiului checkbox nu mai trebuie sa existe');
  assert.ok(!melodia.includes('consentGiven'), 'fetch-ul de checkout nu mai trebuie sa trimita consentGiven');
});

test('melodia-mea.html: dezvaluirea celor 30 de zile de acces ramane, intr-o bara STATICA (nu mai gatata de starea checkoutBtn) — informatie, nu actiune de bifat', () => {
  const barIdx = melodia.indexOf('id="checkout-access-note-bar"');
  const scriptIdx = melodia.indexOf('<script>');
  assert.notEqual(barIdx, -1);
  assert.notEqual(scriptIdx, -1);
  assert.ok(barIdx < scriptIdx, 'bara trebuie sa fie in DOM INAINTE ca <script> sa ruleze applyStaticTexts()');
  const noteCount = (melodia.match(/checkout_access_note:/g) || []).length;
  assert.equal(noteCount, 8, `asteptat 8 aparitii checkout_access_note, gasit ${noteCount}`);
});

test('melodia-mea.html: goToCheckout() nu mai verifica niciun checkbox propriu si trimite cererea de checkout fara body — Stripe respinge singur plata fara bifa', () => {
  const fn = extractFn(melodia, 'async function goToCheckout() {');
  assert.ok(!fn.includes('checkoutConsentCheckbox'));
  assert.ok(!fn.includes("body: JSON.stringify"));
});

// ---------------------------------------------------------------------------------------------
// Durable confirmation — emailul de livrare
// ---------------------------------------------------------------------------------------------
test('server.js: sendDeliveryEmail() include legalLine (mentiunea consimtamantului) in toate cele 8 sabloane, inainte de "— NALUNA"', () => {
  const fn = extractFn(server, 'async function sendDeliveryEmail(order) {');
  const legalLineCount = (fn.match(/\$\{legalLine\}/g) || []).length;
  assert.equal(legalLineCount, 8, `asteptat 8 sabloane cu \${legalLine}, gasit ${legalLineCount}`);
  const domainLinksCount = (fn.match(/\$\{DOMAIN\}\/terms\.html/g) || []).length;
  assert.equal(domainLinksCount, 8);
});

// ---------------------------------------------------------------------------------------------
// Retention / deletion (Faza 5)
// ---------------------------------------------------------------------------------------------
test('server.js: POST /api/admin/orders/:orderId/anonymize exista, refuza o comanda ACTIVA (generating/processing/regenerating/video lock)', () => {
  const fn = extractFn(server, "app.post('/api/admin/orders/:orderId/anonymize', async (req, res, next) => {");
  assert.match(fn, /order\.status === 'generating'/);
  assert.match(fn, /order\.status === 'processing_provider_result'/);
  assert.match(fn, /order\.regenerationStatus === 'running'/);
  assert.match(fn, /await isVideoRenderActiveForOrder\(order\)/);
  assert.match(fn, /res\.status\(409\)/);
});

test('server.js: anonymize sterge REAL fisierele din storage (fullKey/previewKey/videoKey/uploadedMedia keys), izolat per fisier (un esec nu opreste restul)', () => {
  const fn = extractFn(server, "app.post('/api/admin/orders/:orderId/anonymize', async (req, res, next) => {");
  assert.match(fn, /storage\.deletePrivateFile\(key\)/);
  assert.match(fn, /v\.fullKey/);
  assert.match(fn, /v\.previewKey/);
  assert.match(fn, /v\.videoKey/);
  assert.match(fn, /m\.key/);
  assert.match(fn, /try\s*\{\s*await storage\.deletePrivateFile\(key\);\s*\}\s*catch/);
});

test('server.js: anonymize apeleaza db.anonymizeOrder() DUPA stergerea fisierelor din storage (fisierele nu raman orfane referentiate)', () => {
  const fn = extractFn(server, "app.post('/api/admin/orders/:orderId/anonymize', async (req, res, next) => {");
  const deleteIdx = fn.lastIndexOf('storage.deletePrivateFile');
  const anonIdx = fn.indexOf('db.anonymizeOrder(order.id)');
  assert.notEqual(anonIdx, -1);
  assert.ok(deleteIdx < anonIdx);
});

test('db.js: anonymizeOrder() pastreaza id/pret/status/plan (contabilitate), sterge identitate/continut/media, email devine placeholder .invalid (RFC 2606), NICIODATA livrabil', () => {
  const fn = extractFn(db, 'async function anonymizeOrder(id) {');
  assert.match(fn, /recipient = '\[deleted\]'/);
  assert.match(fn, /story = '\[deleted\]'/);
  assert.match(fn, /sender_name = NULL/);
  assert.match(fn, /uploaded_media = '\[\]'::jsonb/);
  assert.match(fn, /variants = '\[\]'::jsonb/);
  assert.match(fn, /anonymized_at = now\(\)/);
  assert.match(fn, /@nalunastudio\.invalid/);
  assert.ok(!fn.includes('price'), 'pretul NU trebuie atins de anonimizare — necesar contabil');
  assert.ok(!fn.includes('status ='), 'statusul NU trebuie atins de anonimizare');
});

test('db.js: anonymized_at exista in schema (audit minim)', () => {
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;/);
});

// ---------------------------------------------------------------------------------------------
// Retentie materiale SURSA (Faza 6, 2026-09-05) — categorie STRICT separata de produsul FINAL
// ---------------------------------------------------------------------------------------------
test('db.js: source_media_purged_at exista in schema, findOrdersEligibleForSourceMediaPurge cauta STRICT plan video + status ready + regenerare inactiva, purgeOrderSourceMedia NU atinge variants/videoKey', () => {
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_media_purged_at TIMESTAMPTZ;/);
  const findFn = extractFn(db, 'async function findOrdersEligibleForSourceMediaPurge(cutoffDate) {');
  assert.match(findFn, /plan = 'video'/);
  assert.match(findFn, /status = 'ready'/);
  assert.match(findFn, /regeneration_status IS DISTINCT FROM 'running'/);
  assert.match(findFn, /source_media_purged_at IS NULL/);
  const purgeFn = extractFn(db, 'async function purgeOrderSourceMedia(id) {');
  assert.match(purgeFn, /uploaded_media = '\[\]'::jsonb/);
  assert.ok(!purgeFn.includes('variants'), 'purgeOrderSourceMedia nu trebuie sa atinga variants (produsul final)');
  assert.ok(!purgeFn.includes('videoKey') && !purgeFn.includes('video_key'), 'purgeOrderSourceMedia nu trebuie sa atinga videoKey (produsul final)');
});

test('server.js: purgeStaleSourceMedia() foloseste ACEEASI CONTENT_RETENTION_DAYS (30) ca produsul final si povestea (regula unica, simplificata runda 3) — sare STRICT o comanda cu randare video activa, fara sa mai verifice separat existenta videoKey (status=\'ready\' o garanteaza deja)', () => {
  assert.match(server, /const CONTENT_RETENTION_DAYS = 30;/);
  const fn = extractFn(server, 'async function purgeStaleSourceMedia() {');
  assert.match(fn, /CONTENT_RETENTION_DAYS/);
  assert.match(fn, /isVideoRenderActiveForOrder\(order\)/);
  assert.match(fn, /db\.purgeOrderSourceMedia\(order\.id\)/);
});

test('server.js: curatarea materialelor sursa ruleaza automat (setInterval, .unref()) SI e declansabila manual pentru testare/audit prin /api/admin/retention/purge-source-media, protejata de acelasi middleware admin', () => {
  assert.match(server, /setInterval\(\(\) => \{ purgeStaleSourceMedia\(\)\.catch/);
  assert.match(server, /\.unref\(\);/);
  const routeIdx = server.indexOf("app.post('/api/admin/retention/purge-source-media'");
  assert.notEqual(routeIdx, -1);
  const adminMwIdx = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth);");
  assert.ok(adminMwIdx !== -1 && adminMwIdx < routeIdx, 'ruta trebuie inregistrata DUPA middleware-ul de autentificare admin');
});

// ---------------------------------------------------------------------------------------------
// Acces gazduit 30 de zile la produsul FINAL (decizie de business 2026-09-06 — inlocuieste
// gate-ul anterior: perioada e acum DECISA si REAL implementata, nu doar descrisa)
// ---------------------------------------------------------------------------------------------
test('Privacy Policy/Terms/Refund: perioada de acces gazduit la produsul final e EXACT "30 days"/"30 de zile" peste tot — niciodata "1 month"/"o luna", niciodata "permanent"/"lifetime"', () => {
  for (const page of ['privacy.html', 'terms.html', 'refund.html']) {
    const html = read(`public/${page}`);
    assert.match(html, /30 days? from delivery|30-day/i, `${page} trebuie sa declare explicit 30 de zile`);
    assert.ok(!/\b1\s*month\b|\bone month\b/i.test(html), `${page} nu trebuie sa foloseasca "1 month"/"one month" in loc de "30 days"`);
    assert.ok(!/\b(permanent|lifetime|forever)\b/i.test(html), `${page} nu trebuie sa promita o disponibilitate "permanenta"/"lifetime"`);
  }
});

test('Terms/Refund/Privacy: expirarea accesului gazduit e declarata explicit ca NEAFECTAND drepturile statutare / evidenta contabila-legala', () => {
  const terms = read('public/terms.html');
  const refund = read('public/refund.html');
  const privacy = read('public/privacy.html');
  assert.match(terms, /does not affect your statutory rights/);
  assert.match(refund, /does not affect any of your statutory rights|does not itself entitle you to a refund/);
  assert.match(privacy, /does not affect your statutory rights/);
  assert.match(privacy, /order record.*is kept separately and is not deleted at the same time/s);
});

test('server.js: CONTENT_RETENTION_DAYS=30, hostedAccessExpiresAt calculeaza STRICT din paidAt (nu createdAt), isHostedAccessExpired e time-based', () => {
  assert.match(server, /const CONTENT_RETENTION_DAYS = 30;/);
  const fn = extractFn(server, 'function hostedAccessExpiresAt(order) {');
  assert.match(fn, /order\.paidAt/);
  assert.ok(!fn.includes('createdAt'), 'reperul trebuie sa fie livrarea (paidAt), niciodata crearea comenzii');
});

test('server.js: toate cele 4 rute de descarcare a produsului final (/media/full, /media/full/:id/gift, /media/wav, /media/video) refuza cu 410 cand accesul gazduit a expirat, INAINTE de a semna vreun URL', () => {
  for (const sig of [
    "app.get('/media/full/:orderId', async (req, res, next) => {",
    "app.get('/media/full/:orderId/gift', async (req, res, next) => {",
    "app.get('/media/wav/:orderId', async (req, res, next) => {",
    "app.get('/media/video/:orderId', async (req, res, next) => {"
  ]) {
    const fn = extractFn(server, sig);
    const expiredIdx = fn.indexOf('isHostedAccessExpired(order)');
    const signIdx = fn.indexOf('getSignedDownloadUrl');
    assert.notEqual(expiredIdx, -1, `${sig} trebuie sa verifice isHostedAccessExpired`);
    assert.ok(signIdx === -1 || expiredIdx < signIdx, `${sig}: verificarea de expirare trebuie sa fie INAINTE de semnarea URL-ului`);
    assert.match(fn, /res\.status\(410\)/);
  }
});

test('server.js: cele 4 rute de descarcare folosesc attachmentDisposition (Content-Disposition: attachment) — descarcare reala pe mobil (Safari iOS deschide altfel inline resursele cross-origin)', () => {
  for (const sig of [
    "app.get('/media/full/:orderId', async (req, res, next) => {",
    "app.get('/media/full/:orderId/gift', async (req, res, next) => {",
    "app.get('/media/wav/:orderId', async (req, res, next) => {",
    "app.get('/media/video/:orderId', async (req, res, next) => {"
  ]) {
    const fn = extractFn(server, sig);
    assert.match(fn, /attachmentDisposition\(/, `${sig} trebuie sa foloseasca attachmentDisposition`);
  }
  const dispoFn = extractFn(server, 'function attachmentDisposition(baseName, ext) {');
  assert.match(dispoFn, /filename\*=UTF-8''/, 'trebuie sa suporte diacritice (RFC 5987), nu doar ASCII');
});

test('storage.js: getSignedDownloadUrl accepta un al treilea parametru contentDisposition, trimis ca ResponseContentDisposition catre R2/S3 DOAR daca e furnizat (preview-urile raman nedistorsionate)', () => {
  const storage = read('storage.js');
  const fn = extractFn(storage, 'async function getSignedDownloadUrl(key, expirySeconds = 600, contentDisposition = null) {');
  assert.match(fn, /ResponseContentDisposition: contentDisposition/);
});

test('GET /api/orders/access/:token si GET /api/orders/:orderId expun hostedAccessExpiresAt/hostedAccessExpired — calculat live, nu doar dupa ce maturarea zilnica a rulat', () => {
  const accessFn = extractFn(server, "app.get('/api/orders/access/:token', lookupLimiter, async (req, res, next) => {");
  assert.match(accessFn, /hostedAccessExpiresAt\(order\)/);
  assert.match(accessFn, /hostedAccessExpired: isHostedAccessExpired\(order\)/);
  const orderFn = extractFn(server, "app.get('/api/orders/:orderId', async (req, res, next) => {");
  assert.match(orderFn, /hostedAccessExpiresAt\(order\)/);
  assert.match(orderFn, /hostedAccessExpired: isHostedAccessExpired\(order\)/);
});

test('db.js: final_media_expired_at exista in schema, findOrdersEligibleForFinalMediaExpiry cauta STRICT status ready + neanonimizata + regenerare inactiva, expireOrderFinalMedia scrie STRICT variants+final_media_expired_at (nu atinge recipient/story/pret/status)', () => {
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_media_expired_at TIMESTAMPTZ;/);
  const findFn = extractFn(db, 'async function findOrdersEligibleForFinalMediaExpiry(cutoffDate) {');
  assert.match(findFn, /status = 'ready'/);
  assert.match(findFn, /anonymized_at IS NULL/);
  assert.match(findFn, /regeneration_status IS DISTINCT FROM 'running'/);
  const expireFn = extractFn(db, 'async function expireOrderFinalMedia(id, newVariants) {');
  assert.match(expireFn, /UPDATE orders SET variants = \$2::jsonb, final_media_expired_at = now\(\)/);
  assert.ok(!expireFn.includes('recipient') && !expireFn.includes('story') && !expireFn.includes('price') && !expireFn.includes('status ='));
});

test('server.js: expireStaleFinalMedia() sterge REAL toate cele 5 chei media (fullKey/previewKey/videoKey/videoPreviewKey/wavKey) din storage, izolat per fisier, sare o randare video activa, ruleaza zilnic (setInterval) SI e declansabila manual (admin)', () => {
  const fn = extractFn(server, 'async function expireStaleFinalMedia() {');
  for (const key of ['v.fullKey', 'v.previewKey', 'v.videoKey', 'v.videoPreviewKey', 'v.wavKey']) {
    assert.ok(fn.includes(key), `expireStaleFinalMedia trebuie sa colecteze ${key} pentru stergere`);
  }
  assert.match(fn, /isVideoRenderActiveForOrder\(order\)/);
  assert.match(fn, /db\.expireOrderFinalMedia\(order\.id, newVariants\)/);
  assert.match(server, /setInterval\(\(\) => \{ expireStaleFinalMedia\(\)\.catch/);
  const routeIdx = server.indexOf("app.post('/api/admin/retention/expire-final-media'");
  const adminMwIdx = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth);");
  assert.ok(routeIdx !== -1 && adminMwIdx !== -1 && adminMwIdx < routeIdx, 'ruta manuala trebuie protejata de acelasi middleware admin');
});

test('comanda-mea.html: cand hostedAccessExpired e true, se afiseaza STRICT starea curata de expirare (access_expired_title/body) — NICIODATA playerul/linkurile de descarcare (ar fi sparte)', () => {
  const html = read('public/comanda-mea.html');
  const fn = extractFn(html, 'async function lookup(tokenOverride) {');
  assert.match(fn, /const accessExpired = o\.status === 'ready' && !!o\.hostedAccessExpired;/);
  assert.match(fn, /accessExpired \? `/);
  assert.match(fn, /t\.access_expired_title/);
  assert.match(fn, /t\.access_expired_body/);
  // playerul/linkurile de extras sunt STRICT conditionate de "!accessExpired"
  assert.match(fn, /!accessExpired && \(o\.plan === 'premium' \|\| o\.plan === 'video'\) && o\.hasWav/);
});

test('comanda-mea.html: toate cele 8 limbi au access_expired_title, access_expired_body, download_tip_ios si download_tip_android (ghidare descarcare SEPARATA per dispozitiv, FARA promisiunea falsa de salvare automata in Poze/Galerie)', () => {
  const html = read('public/comanda-mea.html');
  for (const key of ['access_expired_title', 'access_expired_body', 'download_tip_ios', 'download_tip_android']) {
    const count = (html.match(new RegExp(`${key}:`, 'g')) || []).length;
    assert.equal(count, 8, `asteptat 8 aparitii ${key}, gasit ${count}`);
  }
  assert.ok(!/automatically save[sd]? to (your )?(photos|gallery|camera roll)/i.test(html), 'nu trebuie afirmata o salvare automata in Poze/Galerie — necesita mereu o actiune a utilizatorului');
});

test('comanda-mea.html: getDeviceDownloadTip() arata STRICT sfatul relevant (iOS/Android), niciodata ambele combinate, si nimic pe desktop', () => {
  const html = read('public/comanda-mea.html');
  const fn = extractFn(html, 'function getDeviceDownloadTip() {');
  assert.match(fn, /iPhone\|iPad\|iPod/i);
  assert.match(fn, /Android/i);
  assert.match(fn, /return t\.download_tip_ios/);
  assert.match(fn, /return t\.download_tip_android/);
  assert.match(fn, /return '';/, 'pe desktop (niciun UA de mobil detectat) nu trebuie afisat niciun sfat');
});

test('melodia-mea.html: checkout_access_note (dezvaluire pre-cumparare a celor 30 de zile) exista in toate cele 8 limbi si e afisat in bara statica de jos, INAINTE de plata', () => {
  const html = read('public/melodia-mea.html');
  const count = (html.match(/checkout_access_note:/g) || []).length;
  assert.equal(count, 8, `asteptat 8 aparitii checkout_access_note, gasit ${count}`);
  assert.ok(html.includes('id="checkout-access-note"'));
  const fn = extractFn(html, 'function applyStaticTexts() {');
  assert.match(fn, /checkout-access-note'\)\.textContent = t\.checkout_access_note;/);
});

test('server.js: CONSENT_POLICY_VERSION e la v6 (v3 adaugase dezvaluirea celor 30 de zile; v4 corecteaza framing-ul factual creare->livrare; v5 muta consimtamantul pe Stripe nativ; v6 corecteaza declansatorul real la CREARE, verificat direct contra terms.html/refund.html) — niciodata retroactiva pentru comenzi deja platite', () => {
  assert.match(server, /const CONSENT_POLICY_VERSION = '2026-09-11-v6';/);
});

test('server.js: emailul de livrare mentioneaza EXPLICIT "30 days"/"30 de zile" (nu "1 month") si incurajarea de a descarca, in toate cele 8 sabloane', () => {
  const fn = extractFn(server, 'async function sendDeliveryEmail(order) {');
  const count = (fn.match(/downloadReminder\}<\/p>/g) || []).length;
  assert.equal(count, 8, `asteptat downloadReminder in toate cele 8 sabloane, gasit ${count}`);
  assert.match(fn, /DOWNLOAD_REMINDER = \{/);
  assert.match(fn, /30 days from delivery/);
});

// ---------------------------------------------------------------------------------------------
// Runda 2 — poveste/personalizare (60 zile), loguri de securitate, robustete paidAt
// ---------------------------------------------------------------------------------------------
test('db.js: story_anonymized_at exista, findOrdersEligibleForStoryAnonymization cauta STRICT status ready + neanonimizata + regenerare inactiva, anonymizeOrderStory NU atinge recipient/senderName/relationship/pret/status', () => {
  assert.match(db, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS story_anonymized_at TIMESTAMPTZ;/);
  const findFn = extractFn(db, 'async function findOrdersEligibleForStoryAnonymization(cutoffDate) {');
  assert.match(findFn, /status = 'ready'/);
  assert.match(findFn, /anonymized_at IS NULL/);
  assert.match(findFn, /regeneration_status IS DISTINCT FROM 'running'/);
  const anonFn = extractFn(db, 'async function anonymizeOrderStory(id) {');
  assert.match(anonFn, /story = '\[expired\]'/);
  assert.ok(!anonFn.includes('recipient') && !anonFn.includes('sender_name') && !anonFn.includes('relationship') && !anonFn.includes('price') && !anonFn.includes('status ='));
});

test('server.js: anonymizeStaleStories() foloseste ACEEASI CONTENT_RETENTION_DAYS (30, simplificare runda 3 — nu mai exista o cifra separata pentru poveste) si ruleaza zilnic SI e declansabila manual (admin)', () => {
  assert.match(server, /const CONTENT_RETENTION_DAYS = 30;/);
  const fn = extractFn(server, 'async function anonymizeStaleStories() {');
  assert.match(fn, /CONTENT_RETENTION_DAYS/);
  assert.match(server, /setInterval\(\(\) => \{ anonymizeStaleStories\(\)\.catch/);
  const routeIdx = server.indexOf("app.post('/api/admin/retention/anonymize-stale-stories'");
  const adminMwIdx = server.indexOf("app.use('/api/admin', adminAuthLimiter, requireAdminAuth);");
  assert.ok(routeIdx !== -1 && adminMwIdx !== -1 && adminMwIdx < routeIdx);
});

test('server.js: NICIUN cod de regenerare/validare a versurilor (care citeste order.story) nu ruleaza pentru o comanda deja "ready" — stergerea povestii dupa 60 de zile nu poate strica un flux automat existent', () => {
  for (const sig of [
    "app.post('/api/orders/:orderId/variants/:variantId/lyrics', express.json(), requireOrderToken, async (req, res, next) => {",
    'async function handlePremiumSelectiveRegenerate(req, res, next) {',
    'async function handleLegacyRegenerate(req, res, next) {'
  ]) {
    const fn = extractFn(server, sig);
    assert.match(fn, /status === 'ready'/, `${sig} trebuie sa refuze o comanda deja platita`);
  }
  const retryFn = extractFn(server, "app.post('/api/admin/orders/:orderId/retry-extras', async (req, res, next) => {");
  assert.ok(!retryFn.includes('order.story'), 'singurul job post-plata (retry-extras) nu trebuie sa citeasca order.story');
});

test('server.js: maskEmailForLog()/redactEmailsInText() exista si sunt folosite la TOATE cele 4 locuri unde adresa clientului ar fi altfel logata in clar (bounce/complaint/suprimare/eroare livrare)', () => {
  const maskFn = extractFn(server, 'function maskEmailForLog(email) {');
  assert.match(maskFn, /str\[0\]|local\[0\]/);
  const usages = (server.match(/maskEmailForLog\(/g) || []).length;
  assert.ok(usages >= 4, `asteptat cel putin 4 folosiri ale maskEmailForLog, gasit ${usages}`);
  assert.match(server, /redactEmailsInText\(err\.message\)/);
});

test('Privacy Policy: o SINGURA regula de retentie (30 de zile) pentru TOT continutul comenzii — produs final, poveste, foto/video originale — si o regula CONCRETA/obiectiva pentru loguri de securitate, fara formulari vagi ("tied to order lifecycle", "short"/"weeks")', () => {
  const html = read('public/privacy.html');
  assert.match(html, /Your order content.*30 days from delivery/s);
  assert.match(html, /personal story or details you wrote for your song/);
  assert.match(html, /photos or videos you uploaded for the Gift Video package/);
  assert.match(html, /Security and error logs/);
  assert.ok(!/\bshort\b.*\bweeks?\b|\bweeks?\b.*\bretained\b/i.test(html), 'nu trebuie sa ramana o formulare vaga tip "short"/"weeks" pentru loguri');
  assert.match(html, /hosting provider's platform retains them by default/);
  assert.ok(!/\b60\s*days\b/i.test(html) && !/\b90\s*days\b/i.test(html), 'nu mai trebuie sa ramana 60 sau 90 de zile — o singura cifra (30) pentru tot continutul comenzii');
});

test('paidAt: scris o singura data, in tranzactie, cu protectie impotriva evenimentelor Stripe duplicate — niciun alt loc din server.js/db.js nu il suprascrie', () => {
  const writeSites = (server.match(/paidAt: new Date\(\)\.toISOString\(\)/g) || []).length;
  assert.equal(writeSites, 1, 'paidAt trebuie scris dintr-un SINGUR loc in server.js');
  const fn = extractFn(db, 'async function recordPaidOrderAtomically(eventId, orderId, patch) {');
  assert.match(fn, /FOR UPDATE/, 'citirea comenzii inainte de scriere trebuie sa faca row-lock (evita o cursa intre 2 evenimente Stripe simultane)');
  assert.match(fn, /current\.status === 'ready'.*alreadyPaid: true/s, 'un al doilea eveniment de plata pentru aceeasi comanda NU trebuie sa suprascrie paid_at');
});

test('Checkout: pentru pachetul video, atat crearea sesiunii Stripe CAT SI webhook-ul de confirmare verifica INDEPENDENT ca videoKey exista INAINTE de a seta paidAt — livrarea e deja garantata la momentul platii, pentru toate pachetele', () => {
  const checkoutFn = extractFn(server, "app.post('/api/orders/:orderId/checkout', requireOrderToken, async (req, res, next) => {");
  assert.match(checkoutFn, /videoVariant\.videoKey/);
  assert.match(checkoutFn, /status\(400\)\.json\(\{ error: 'Videoclipul tău nu este încă gata/);
});

test('Privacy Policy: perioada declarata public (30 de zile, TOT continutul comenzii) corespunde EXACT constantei reale unice din server.js (CONTENT_RETENTION_DAYS) — nu un numar inventat, si e declarata explicit ca alegere operationala', () => {
  const html = read('public/privacy.html');
  const server = read('server.js');
  assert.match(html, /30 days from delivery/);
  assert.match(server, /const CONTENT_RETENTION_DAYS = 30;/, 'perioada declarata public trebuie sa corespunda EXACT constantei reale din server.js');
  assert.ok(html.includes('not a legal requirement'), 'trebuie sa clarifice ca perioada de 30 de zile e o alegere operationala, nu o obligatie legala');
});

test('Privacy Policy: retentia inregistrarilor de consimtamant (6 ani) si a celor contabile/fiscale (5 ani de la 31 ianuarie) sunt distincte, cu sursa legala/justificare pentru fiecare', () => {
  const html = read('public/privacy.html');
  assert.match(html, /consent you gave at checkout.*kept for 6 years/s);
  assert.match(html, /kept for 5 years from the 31 January/);
  assert.ok(html.includes('HMRC'), 'perioada contabila trebuie legata explicit de o obligatie legala reala (HMRC), nu inventata');
});

test('Privacy Policy: transferul international mentioneaza tara reala (United States) si NU afirma safeguard-uri nesustinute — angajament declarat, nu fapt istoric neverificabil despre furnizori', () => {
  const html = read('public/privacy.html');
  assert.ok(html.includes('United States'));
  assert.ok(html.includes('we only work with providers who commit contractually'), 'formularea trebuie sa fie un angajament al Naluna, nu o afirmatie despre documentatia deja semnata a fiecarui furnizor');
});
