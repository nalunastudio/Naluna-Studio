// Deliverability (2026-09-01): Resend "Deliverability Insights" semnaleaza explicit lipsa unei
// variante text/plain drept un motiv real de suspiciune pentru Gmail/Yahoo/Outlook pe un email
// trimis STRICT ca HTML. Generam varianta text AUTOMAT din html-ul real trimis (niciodata scrisa
// manual, per limba/sablon) — garanteaza ca ramane mereu sincronizata cu ce vede clientul in
// varianta HTML, fara risc de divergenta intre cele doua in timp, pe masura ce sabloanele se
// modifica. Acopera STRICT tag-urile chiar folosite in sabloanele Naluna (p, a, strong, ul/li,
// br) — nu un parser HTML general.
function htmlToPlainText(html) {
  return String(html == null ? '' : html)
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2: $1')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|ul|ol)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Escapare HTML pentru continut introdus de client (recipient, story etc.) inainte de
// interpolare in sabloanele de email — mutata aici din server.js (2026-09-25, sistem recovery
// emails) ca sa fie reutilizabila si de lib/recovery-emails/templates.js, o singura sursa de
// adevar. Comportament NESCHIMBAT fata de implementarea originala.
function escapeHtmlForEmail(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { htmlToPlainText, escapeHtmlForEmail };
