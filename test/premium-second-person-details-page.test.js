// Teste pentru runda 2026-08-13 — "PAGINĂ SEPARATĂ PENTRU DATELE PERSOANEI A DOUA" (exclusiv
// Premium): (1) mini-pagina dedicata (pasul 8), inlocuind campul vechi "Numele destinatarului";
// (2) separarea completa a datelor celor doua melodii (senderName2/relationship2/story2, NICIODATA
// copiate din melodia 1); (3) Standard/Video raman STRICT neschimbate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const comanda = read('public/comanda.html');
const server = read('server.js');
const dbjs = read('db.js');

// ---------------------------------------------------------------------------------------------
// (1) Campul vechi eliminat / mini-pagina noua.
// ---------------------------------------------------------------------------------------------
test('comanda.html: campul vechi "Numele destinatarului" (label) nu mai exista — a fost inlocuit cu "Numele celei de-a doua persoane"', () => {
  assert.ok(!comanda.includes("song2_recipient_name_label: 'Numele destinatarului',"), 'textul vechi nu mai trebuie sa existe in nicio limba');
  assert.match(comanda, /song2_recipient_name_label: 'Numele celei de-a doua persoane',/);
});

test('comanda.html: campul de nume (input HTML #song2-recipient-name) exista o SINGURA data in marcaj — mutat pe pasul 7, niciodata duplicat pe pasul 6', () => {
  const occurrences = (comanda.match(/<input type="text" id="song2-recipient-name"/g) || []).length;
  assert.equal(occurrences, 1, `elementul trebuie sa existe o singura data in HTML (mutat, nu duplicat), gasit de ${occurrences} ori`);
});

test('comanda.html: pasul 7 (mini-pagina) exista, e ascuns implicit, si contine cele 4 campuri in ordinea ceruta: nume, expeditor, relatie, poveste', () => {
  const stepIdx = comanda.indexOf('data-step="7"');
  assert.ok(stepIdx !== -1, 'trebuie sa existe un pas 7');
  const stepStart = comanda.lastIndexOf('<div class="step-card"', stepIdx);
  assert.ok(comanda.slice(stepStart, stepIdx + 40).includes('style="display:none;"'), 'pasul 7 trebuie sa fie ascuns implicit, ca toti ceilalti pasi');
  const nextStepIdx = comanda.indexOf('</form>', stepIdx);
  const body = comanda.slice(stepIdx, nextStepIdx);
  const nameIdx = body.indexOf('id="song2-recipient-name"');
  const senderIdx = body.indexOf('id="song2-sender-name"');
  const relationshipIdx = body.indexOf('id="song2-relationship"');
  const storyIdx = body.indexOf('id="song2-story"');
  assert.ok(nameIdx !== -1 && senderIdx !== -1 && relationshipIdx !== -1 && storyIdx !== -1, 'toate cele 4 campuri trebuie sa existe pe pasul 7');
  assert.ok(nameIdx < senderIdx && senderIdx < relationshipIdx && relationshipIdx < storyIdx, 'ordinea trebuie sa fie exact: nume, expeditor, relatie, poveste');
});

test('comanda.html: mini-pagina reutilizeaza EXACT cheile de traducere existente pentru expeditor/relatie/poveste (label_sender, label_relationship, label_story) — niciun text romanesc hardcodat, nicio cheie noua duplicata', () => {
  const stepIdx = comanda.indexOf('data-step="7"');
  const nextStepIdx = comanda.indexOf('</form>', stepIdx);
  const body = comanda.slice(stepIdx, nextStepIdx);
  assert.ok(body.includes('data-i18n="label_sender"'));
  assert.ok(body.includes('data-i18n="label_relationship"'));
  assert.ok(body.includes('data-i18n="label_story"'));
  assert.ok(body.includes('data-i18n-placeholder="ph_sender"'));
  assert.ok(body.includes('data-i18n-placeholder="ph_relationship"'));
  assert.ok(body.includes('data-i18n-placeholder="ph_story"'));
});

test('comanda.html: mini-pagina apare STRICT dupa pasul 6 (data-prev="6") si nu exista pentru Standard/Video (getTotalSteps ramane 4 pentru ele)', () => {
  const stepIdx = comanda.indexOf('data-step="7"');
  const nextStepIdx = comanda.indexOf('</form>', stepIdx);
  const body = comanda.slice(stepIdx, nextStepIdx);
  assert.ok(body.includes('data-prev="6"'));
  assert.match(comanda, /function getTotalSteps\(\) \{\s*if \(selectedPlan\.id !== 'premium'\) return 4;/);
});

test('comanda.html: pasul 7 apare STRICT cand "Pentru altă persoană" a fost ales (getTotalSteps intoarce 7 doar in acel caz) — "Pentru aceeași persoană" ramane la 6 pasi', () => {
  assert.match(comanda, /return song2TargetInput\.value === 'other' \? 7 : 6;/);
});

test('comanda.html: submit handler-ul de pe pasul 6 redirectioneaza catre pasul 7 (nu trimite direct comanda) STRICT cand song2Target=other — acelasi tipar ca redirectarea pasului 4->5', () => {
  const idx = comanda.indexOf("form.addEventListener('submit'");
  const body = comanda.slice(idx, idx + 2000);
  assert.match(body, /if \(selectedPlan\.id === 'premium' && currentStep === 6 && song2TargetInput\.value === 'other'\) \{\s*updateSong2DetailsContinueState\(\);\s*showStep\(7\);\s*return;\s*\}/);
});

test('comanda.html: campul de nume ramane vizibil condiționat (ascuns cand "Amândoi" e ales) — mecanismul refreshSong2OtherUI() ramane neschimbat, doar elementul a fost mutat', () => {
  assert.ok(comanda.includes("song2SingleNameField.style.display = 'none';"));
  assert.ok(comanda.includes("song2SingleNameField.style.display = 'block';"));
});

test('comanda.html: revenirea la pasul anterior (Înapoi) pastreaza valorile — saveDraft()/restoreDraft() includ song2SenderName/song2Relationship/song2Story', () => {
  assert.match(comanda, /song2SenderName: song2SenderNameInput\.value,/);
  assert.match(comanda, /song2Relationship: song2RelationshipInput\.value,/);
  assert.match(comanda, /song2Story: song2StoryInput\.value/);
  assert.match(comanda, /if \(draft\.song2SenderName\) song2SenderNameInput\.value = draft\.song2SenderName;/);
  assert.match(comanda, /if \(draft\.song2Relationship\) song2RelationshipInput\.value = draft\.song2Relationship;/);
  assert.match(comanda, /if \(draft\.song2Story\) song2StoryInput\.value = draft\.song2Story;/);
});

test('comanda.html: butonul final al mini-paginii este dezactivat pana toate campurile obligatorii sunt completate (song2DetailsAllValid)', () => {
  assert.match(comanda, /function song2DetailsAllValid\(\) \{/);
  assert.ok(comanda.includes('id="song2-details-continue-btn" disabled'));
});

// ---------------------------------------------------------------------------------------------
// (2) Payload — separare completa, niciodata copiate din melodia 1.
// ---------------------------------------------------------------------------------------------
test('comanda.html: collectPayload() trimite senderName2/relationship2/story2 STRICT din campurile proprii melodiei 2 (song2-sender-name/song2-relationship/song2-story), niciodata din #sender/#relationship/#story (melodia 1)', () => {
  const idx = comanda.indexOf('function collectPayload()');
  const end = comanda.indexOf('function saveDraft()', idx);
  const body = comanda.slice(idx, end);
  assert.match(body, /senderName2: \(selectedPlan\.id === 'premium' && song2TargetInput\.value === 'other'\)\s*\?\s*song2SenderNameInput\.value\s*:\s*null,/);
  assert.match(body, /relationship2: \(selectedPlan\.id === 'premium' && song2TargetInput\.value === 'other'\)\s*\?\s*song2RelationshipInput\.value\s*:\s*null,/);
  assert.match(body, /story2: \(selectedPlan\.id === 'premium' && song2TargetInput\.value === 'other'\)\s*\?\s*song2StoryInput\.value\s*:\s*null/);
});

test('comanda.html: pentru Standard/Video, senderName2/relationship2/story2 sunt intotdeauna null in payload (nu se aplica)', () => {
  const idx = comanda.indexOf('senderName2: (selectedPlan.id === ');
  const snippet = comanda.slice(idx, idx + 700);
  assert.ok(snippet.includes(': null,'));
});

// ---------------------------------------------------------------------------------------------
// Backend — validare, persistenta, si conectarea la buildPrompt (getSong2EffectiveData).
// ---------------------------------------------------------------------------------------------
test('server.js: POST /api/orders valideaza senderName2/relationship2/story2 cu ACELEASI reguli ca senderName/relationship/story (isValidString), STRICT cand plan=premium si song2Target=other', () => {
  const idx = server.indexOf("if (!isValidString(recipient2, 1, 60)) {");
  const body = server.slice(idx, idx + 1200);
  assert.match(body, /if \(!isValidString\(senderName2, 1, 100\)\) \{/);
  assert.match(body, /if \(!isValidString\(relationship2, 1, 60\)\) \{/);
  assert.match(body, /if \(!isValidString\(story2, 5, 2000\)\) \{/);
});

test('server.js: db.createOrder() primeste senderName2/relationship2/story2 (persistate, niciodata copiate din senderName/relationship/story)', () => {
  const idx = server.indexOf('senderName2: safeSenderName2,');
  assert.ok(idx !== -1);
  const body = server.slice(idx, idx + 100);
  assert.ok(body.includes('relationship2: safeRelationship2,'));
  assert.ok(body.includes('story2: safeStory2'));
});

test('db.js: sender_name_2/relationship_2/story_2 sunt coloane aditive (ADD COLUMN IF NOT EXISTS) — migratie sigura, fara sa afecteze comenzile existente', () => {
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS sender_name_2 TEXT;'));
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS relationship_2 TEXT;'));
  assert.ok(dbjs.includes('ALTER TABLE orders ADD COLUMN IF NOT EXISTS story_2 TEXT;'));
});

test('db.js: createOrder() insereaza cele 3 coloane noi, rowToOrder() le expune ca senderName2/relationship2/story2', () => {
  assert.ok(dbjs.includes('sender_name_2, relationship_2, story_2'));
  assert.ok(dbjs.includes('senderName2: row.sender_name_2 || null,'));
  assert.ok(dbjs.includes('relationship2: row.relationship_2 || null,'));
  assert.ok(dbjs.includes('story2: row.story_2 || null,'));
});

// ---------------------------------------------------------------------------------------------
// (3) Standard/Video raman STRICT neschimbate.
// ---------------------------------------------------------------------------------------------
test('comanda.html: campurile #sender/#relationship/#story (melodia 1, Standard/Video/Premium) raman EXACT neschimbate — nicio modificare la pasul 2', () => {
  const stepIdx = comanda.indexOf('data-step="2"');
  const nextStepIdx = comanda.indexOf('data-step="3"', stepIdx);
  const body = comanda.slice(stepIdx, nextStepIdx);
  assert.ok(body.includes('id="sender"'));
  assert.ok(body.includes('id="relationship"'));
  assert.ok(body.includes('id="story"'));
  assert.ok(!body.includes('song2'), 'pasul 2 (comun tuturor pachetelor) nu trebuie sa contina nimic legat de melodia 2');
});

test('server.js: validarea/campurile senderName/relationship/story (melodia 1) raman neatinse — nicio schimbare in afara de campurile noi *2', () => {
  assert.ok(server.includes("senderName: senderName.trim(), relationship: relationship.trim(),"));
});
