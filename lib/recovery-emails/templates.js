// lib/recovery-emails/templates.js
// Sabloanele de email pentru cele 3 tipuri de notificare (preview_ready / preview_recovery /
// checkout_recovery), in toate cele 8 limbi suportate de comenzi (ALLOWED_LANGS din server.js:
// ro, en, de, es, it, fr, bg, tr). ACELASI tipar exact ca blocurile per-limba din
// sendDeliveryEmail (server.js) — obiect literal cu cate o cheie per limba, rezolvat STRICT prin
// `OBJ[lang] || OBJ.ro` — fallback pe RO se intampla DOAR pentru un order.lang corupt/necunoscut
// (in afara ALLOWED_LANGS), niciodata pentru una din cele 8 limbi valide (fiecare are propria
// cheie completa aici, verificat exhaustiv de test/recovery-email-templates.test.js).
//
// Text NEUTRU, explicit cerut de user pentru preview_recovery — NU presupune "nu ti-a placut
// melodia", foloseste o formulare gen "vrei sa mai schimbi ceva?".

const { escapeHtmlForEmail, htmlToPlainText } = require('../email-text');

const LANGS = ['ro', 'en', 'de', 'es', 'it', 'fr', 'bg', 'tr'];

function resolveLang(lang) {
  return LANGS.includes(lang) ? lang : 'ro';
}

// Link sigur inapoi la comanda — ACELASI format exact ca linkurile deja trimise de
// sendDeliveryEmail (${DOMAIN}/melodia-mea.html?id=...&token=...), refolosind accessToken-ul deja
// existent al comenzii (randomBytes(24).toString('hex'), vezi server.js) — niciun token nou,
// niciun risc de acces la alta comanda (tokenul e per-comanda, opac, deja verificat de
// requireOrderToken la orice ruta care il foloseste).
function buildOrderLink(domain, orderId, accessToken) {
  return `${domain}/melodia-mea.html?id=${encodeURIComponent(orderId)}&token=${encodeURIComponent(accessToken)}`;
}

// email: adresa normalizata (lower(trim())) — inclusa DIRECT in link (nu doar tokenul), ca
// verificarea server-side (verifyUnsubscribeToken) sa fie un simplu HMAC(email) === token, fara
// nicio baza de date suplimentara "token -> email".
function buildUnsubscribeLink(domain, email, unsubscribeToken) {
  return `${domain}/api/email-marketing/unsubscribe?email=${encodeURIComponent(email)}&token=${encodeURIComponent(unsubscribeToken)}`;
}

const UNSUBSCRIBE_TEXT = {
  ro: 'Nu mai vrei sa primesti astfel de mesaje?',
  en: "Don't want to receive messages like this?",
  de: 'Möchtest du solche Nachrichten nicht mehr erhalten?',
  es: '¿No quieres recibir más mensajes como este?',
  it: 'Non vuoi più ricevere messaggi come questo?',
  fr: 'Vous ne voulez plus recevoir ce type de message ?',
  bg: 'Не искате да получавате повече такива съобщения?',
  tr: 'Böyle mesajlar almak istemiyor musunuz?'
};
const UNSUBSCRIBE_LINK_TEXT = {
  ro: 'Dezabonează-te aici', en: 'Unsubscribe here', de: 'Hier abmelden', es: 'Darse de baja aquí',
  it: 'Annulla l\'iscrizione qui', fr: 'Se désabonner ici', bg: 'Отпишете се тук', tr: 'Buradan abonelikten çık'
};

function unsubscribeFooter(lang, domain, email, unsubscribeToken) {
  const link = buildUnsubscribeLink(domain, email, unsubscribeToken);
  return `<p style="font-size:12px;color:#888;margin-top:32px;">${UNSUBSCRIBE_TEXT[lang]} <a href="${link}">${UNSUBSCRIBE_LINK_TEXT[lang]}</a></p>`;
}

// ==========================================================================================
// TIP 1 — preview_ready ("Melodia ta este gata") — OPERATIONAL, fara footer de unsubscribe
// (nu e marketing, e livrare de acces la ce a comandat deja — vezi eligibility.js).
// ==========================================================================================
const PREVIEW_READY_SUBJECT = {
  ro: 'Melodia ta este gata',
  en: 'Your song is ready',
  de: 'Dein Lied ist fertig',
  es: 'Tu canción ya está lista',
  it: 'La tua canzone è pronta',
  fr: 'Ta chanson est prête',
  bg: 'Твоята песен е готова',
  tr: 'Şarkın hazır'
};
const PREVIEW_READY_BODY = {
  ro: (name) => `<p>Salut${name ? `, ${name}` : ''}!</p><p>Melodia ta este gata de ascultat. Am pregătit acest link ca să nu-ți pierzi accesul dacă ai închis pagina în timp ce se genera:</p>`,
  en: (name) => `<p>Hi${name ? `, ${name}` : ''}!</p><p>Your song is ready to listen to. We saved this link so you don't lose access if you closed the page while it was being generated:</p>`,
  de: (name) => `<p>Hallo${name ? `, ${name}` : ''}!</p><p>Dein Lied ist fertig zum Anhören. Wir haben diesen Link für dich aufbewahrt, falls du die Seite während der Erstellung geschlossen hast:</p>`,
  es: (name) => `<p>¡Hola${name ? `, ${name}` : ''}!</p><p>Tu canción ya está lista para escuchar. Guardamos este enlace para que no pierdas el acceso si cerraste la página mientras se generaba:</p>`,
  it: (name) => `<p>Ciao${name ? `, ${name}` : ''}!</p><p>La tua canzone è pronta per l'ascolto. Abbiamo salvato questo link nel caso tu abbia chiuso la pagina durante la generazione:</p>`,
  fr: (name) => `<p>Salut${name ? `, ${name}` : ''} !</p><p>Ta chanson est prête à être écoutée. Nous avons conservé ce lien au cas où tu aurais fermé la page pendant la génération :</p>`,
  bg: (name) => `<p>Здравей${name ? `, ${name}` : ''}!</p><p>Твоята песен е готова за слушане. Запазихме тази връзка, в случай че си затворил страницата, докато се генерираше:</p>`,
  tr: (name) => `<p>Merhaba${name ? `, ${name}` : ''}!</p><p>Şarkın dinlemeye hazır. Oluşturulurken sayfayı kapattıysan erişimini kaybetmemen için bu bağlantıyı sakladık:</p>`
};
const PREVIEW_READY_CTA = {
  ro: 'Ascultă melodia ta', en: 'Listen to your song', de: 'Dein Lied anhören', es: 'Escucha tu canción',
  it: 'Ascolta la tua canzone', fr: 'Écouter ta chanson', bg: 'Слушай своята песен', tr: 'Şarkını dinle'
};

function buildPreviewReadyEmail({ lang, domain, orderId, accessToken, recipientName }) {
  const l = resolveLang(lang);
  const link = buildOrderLink(domain, orderId, accessToken);
  const name = recipientName ? escapeHtmlForEmail(recipientName) : '';
  const html = `${PREVIEW_READY_BODY[l](name)}<p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">${PREVIEW_READY_CTA[l]}</a></p><p><a href="${link}">${link}</a></p>`;
  return { subject: PREVIEW_READY_SUBJECT[l], html, text: htmlToPlainText(html) };
}

// ==========================================================================================
// TIP 2 — preview_recovery ("Vrei sa mai schimbi ceva la melodia ta?") — NEUTRU, cu footer
// de unsubscribe.
// ==========================================================================================
const PREVIEW_RECOVERY_SUBJECT = {
  ro: 'Vrei să mai schimbi ceva la melodia ta?',
  en: 'Want to change anything about your song?',
  de: 'Möchtest du noch etwas an deinem Lied ändern?',
  es: '¿Quieres cambiar algo en tu canción?',
  it: 'Vuoi ancora modificare qualcosa nella tua canzone?',
  fr: 'Tu veux encore changer quelque chose à ta chanson ?',
  bg: 'Искаш ли да промениш нещо в песента си?',
  tr: 'Şarkında değiştirmek istediğin bir şey var mı?'
};
const PREVIEW_RECOVERY_BODY = {
  ro: (name) => `<p>Salut${name ? `, ${name}` : ''}!</p><p>Melodia ta e tot acolo, gata de ascultat. Dacă vrei să mai schimbi ceva — versuri, gen muzical sau orice altceva — poți relua oricând de unde ai rămas:</p>`,
  en: (name) => `<p>Hi${name ? `, ${name}` : ''}!</p><p>Your song is still there, ready to listen to. If you'd like to change anything — lyrics, genre, or anything else — you can pick up right where you left off:</p>`,
  de: (name) => `<p>Hallo${name ? `, ${name}` : ''}!</p><p>Dein Lied ist noch da und bereit zum Anhören. Wenn du noch etwas ändern möchtest — Text, Musikgenre oder etwas anderes — kannst du genau dort weitermachen, wo du aufgehört hast:</p>`,
  es: (name) => `<p>¡Hola${name ? `, ${name}` : ''}!</p><p>Tu canción sigue ahí, lista para escuchar. Si quieres cambiar algo — letra, género musical o cualquier otra cosa — puedes continuar justo donde lo dejaste:</p>`,
  it: (name) => `<p>Ciao${name ? `, ${name}` : ''}!</p><p>La tua canzone è ancora lì, pronta per l'ascolto. Se vuoi modificare qualcosa — testo, genere musicale o altro — puoi riprendere esattamente da dove hai lasciato:</p>`,
  fr: (name) => `<p>Salut${name ? `, ${name}` : ''} !</p><p>Ta chanson est toujours là, prête à être écoutée. Si tu veux encore changer quelque chose — paroles, genre musical ou autre chose — tu peux reprendre exactement là où tu t'étais arrêté :</p>`,
  bg: (name) => `<p>Здравей${name ? `, ${name}` : ''}!</p><p>Твоята песен все още е там, готова за слушане. Ако искаш да промениш нещо — текст, музикален жанр или друго — можеш да продължиш точно от мястото, където си спрял:</p>`,
  tr: (name) => `<p>Merhaba${name ? `, ${name}` : ''}!</p><p>Şarkın hâlâ orada, dinlemeye hazır. Bir şeyi değiştirmek istersen — sözler, müzik türü ya da başka bir şey — kaldığın yerden devam edebilirsin:</p>`
};
const PREVIEW_RECOVERY_CTA = {
  ro: 'Revino la melodia ta', en: 'Go back to your song', de: 'Zurück zu deinem Lied', es: 'Volver a tu canción',
  it: 'Torna alla tua canzone', fr: 'Retourner à ta chanson', bg: 'Върни се към песента си', tr: 'Şarkına geri dön'
};

function buildPreviewRecoveryEmail({ lang, domain, orderId, accessToken, recipientName, email, unsubscribeToken }) {
  const l = resolveLang(lang);
  const link = buildOrderLink(domain, orderId, accessToken);
  const name = recipientName ? escapeHtmlForEmail(recipientName) : '';
  const html = `${PREVIEW_RECOVERY_BODY[l](name)}<p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">${PREVIEW_RECOVERY_CTA[l]}</a></p><p><a href="${link}">${link}</a></p>${unsubscribeFooter(l, domain, email, unsubscribeToken)}`;
  return { subject: PREVIEW_RECOVERY_SUBJECT[l], html, text: htmlToPlainText(html) };
}

// ==========================================================================================
// TIP 3 — checkout_recovery ("Melodia ta te asteapta") — cu footer de unsubscribe. Linkul duce
// STRICT inapoi in aplicatie (melodia-mea.html), NICIODATA direct catre o sesiune Stripe veche
// (care ar putea fi deja expirata) — logica existenta de acolo poate relua/crea checkout-ul in
// siguranta, conform cerintei explicite.
// ==========================================================================================
const CHECKOUT_RECOVERY_SUBJECT = {
  ro: 'Melodia ta te așteaptă',
  en: 'Your song is waiting for you',
  de: 'Dein Lied wartet auf dich',
  es: 'Tu canción te está esperando',
  it: 'La tua canzone ti aspetta',
  fr: 'Ta chanson t\'attend',
  bg: 'Твоята песен те очаква',
  tr: 'Şarkın seni bekliyor'
};
const CHECKOUT_RECOVERY_BODY = {
  ro: (name) => `<p>Salut${name ? `, ${name}` : ''}!</p><p>Ai ajuns până la ultimul pas, dar comanda ta nu a fost încă finalizată. Melodia ta te așteaptă exact așa cum ai lăsat-o — poți continua oricând:</p>`,
  en: (name) => `<p>Hi${name ? `, ${name}` : ''}!</p><p>You made it all the way to the last step, but your order hasn't been completed yet. Your song is waiting for you exactly where you left it — you can continue anytime:</p>`,
  de: (name) => `<p>Hallo${name ? `, ${name}` : ''}!</p><p>Du hast es bis zum letzten Schritt geschafft, aber deine Bestellung ist noch nicht abgeschlossen. Dein Lied wartet genau dort auf dich, wo du aufgehört hast — du kannst jederzeit fortfahren:</p>`,
  es: (name) => `<p>¡Hola${name ? `, ${name}` : ''}!</p><p>Llegaste hasta el último paso, pero tu pedido aún no se ha completado. Tu canción te espera justo donde la dejaste — puedes continuar cuando quieras:</p>`,
  it: (name) => `<p>Ciao${name ? `, ${name}` : ''}!</p><p>Sei arrivato fino all'ultimo passo, ma il tuo ordine non è ancora completato. La tua canzone ti aspetta esattamente dove l'hai lasciata — puoi continuare quando vuoi:</p>`,
  fr: (name) => `<p>Salut${name ? `, ${name}` : ''} !</p><p>Tu es arrivé jusqu'à la dernière étape, mais ta commande n'a pas encore été finalisée. Ta chanson t'attend exactement là où tu l'as laissée — tu peux continuer à tout moment :</p>`,
  bg: (name) => `<p>Здравей${name ? `, ${name}` : ''}!</p><p>Стигна чак до последната стъпка, но поръчката ти все още не е завършена. Твоята песен те очаква точно там, където си спрял — можеш да продължиш по всяко време:</p>`,
  tr: (name) => `<p>Merhaba${name ? `, ${name}` : ''}!</p><p>Son adıma kadar geldin ama siparişin henüz tamamlanmadı. Şarkın tam bıraktığın yerde seni bekliyor — istediğin zaman devam edebilirsin:</p>`
};
const CHECKOUT_RECOVERY_CTA = {
  ro: 'Continuă comanda', en: 'Continue your order', de: 'Bestellung fortsetzen', es: 'Continuar mi pedido',
  it: 'Continua il tuo ordine', fr: 'Continuer ma commande', bg: 'Продължи поръчката', tr: 'Siparişe devam et'
};

function buildCheckoutRecoveryEmail({ lang, domain, orderId, accessToken, recipientName, email, unsubscribeToken }) {
  const l = resolveLang(lang);
  const link = buildOrderLink(domain, orderId, accessToken);
  const name = recipientName ? escapeHtmlForEmail(recipientName) : '';
  const html = `${CHECKOUT_RECOVERY_BODY[l](name)}<p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">${CHECKOUT_RECOVERY_CTA[l]}</a></p><p><a href="${link}">${link}</a></p>${unsubscribeFooter(l, domain, email, unsubscribeToken)}`;
  return { subject: CHECKOUT_RECOVERY_SUBJECT[l], html, text: htmlToPlainText(html) };
}

const BUILDERS = {
  preview_ready: buildPreviewReadyEmail,
  preview_recovery: buildPreviewRecoveryEmail,
  checkout_recovery: buildCheckoutRecoveryEmail
};

function buildNotificationEmail(notificationType, params) {
  const builder = BUILDERS[notificationType];
  if (!builder) throw new Error(`Tip de notificare necunoscut: ${notificationType}`);
  return builder(params);
}

module.exports = {
  LANGS,
  resolveLang,
  buildOrderLink,
  buildUnsubscribeLink,
  buildPreviewReadyEmail,
  buildPreviewRecoveryEmail,
  buildCheckoutRecoveryEmail,
  buildNotificationEmail
};
