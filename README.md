# NALUNA — generator de melodii personalizate

Site de comenzi cadou: melodie personalizata generata prin AI, preview gratuit inainte de plata, plata securizata prin Stripe, livrare automata pe email. Vanzare restrictionata tehnic la Marea Britanie, 8 limbi de interfata.

## Ce contine

- `public/index.html` — landing page, formular comanda, preview cu 2 variante, checkout
- `public/succes.html` — pagina de asteptare / livrare dupa plata
- `public/comanda-mea.html` — recuperare comanda prin cod de acces unic (nu prin email)
- `private/admin.html` — panou owner: comenzi, venit (protejat cu parola)
- `server.js` — backend Express: validare, rate limiting, Stripe, webhook, generare muzica, email
- `db.js` — strat PostgreSQL (inlocuieste vechiul fisier `orders.json`)
- `nixpacks.toml` — spune Railway sa instaleze `ffmpeg` la build
- `.env.example` — sablon cu toate variabilele de mediu necesare

## Flux complet

1. Clientul completeaza formularul si apasa **"Genereaza previzualizarea"** — gratuit, fara plata.
2. Serverul genereaza **2 variante** in paralel, taie 55 secunde din fiecare cu `ffmpeg`, citeste durata reala cu `ffprobe`.
3. Clientul asculta, alege o varianta sau apasa **"Editeaza cantecul"** — 3 runde gratuite.
4. Apasa **"Finalizeaza cadoul"** -> Stripe Checkout, restrictionat tehnic la clienti din UK.
5. Dupa plata confirmata (webhook), fisierul complet se deblocheaza si pleaca automat un **email de livrare** cu link direct.
6. Daca plata esueaza/e abandonata, clientul revine si vede bannerul de recuperare — comanda ramane salvata.
7. Clientul isi poate regasi oricand comanda la `/comanda-mea.html`, folosind **codul de acces unic** primit pe email — nu prin simpla introducere a adresei de email.

## Setup, in ordine

### 1. Baza de date — PostgreSQL
Pe Railway: din dashboard, **New -> Database -> Add PostgreSQL**. Railway injecteaza automat `DATABASE_URL` in serviciul tau Node — nu mai trebuie sa faci nimic manual, `db.js` creeaza singur tabela la prima pornire.

Local: instalezi Postgres sau rulezi `docker run -p 5432:5432 -e POSTGRES_PASSWORD=parola postgres`, apoi pui `DATABASE_URL` in `.env`.

### 2. Cont Stripe
- Creezi cont pe stripe.com, activezi platile in GBP.
- Din Dashboard -> Developers -> API keys, copiezi `STRIPE_SECRET_KEY`.
- Din Developers -> Webhooks, adaugi endpoint `https://domeniul-tau.ro/api/webhook`, selectezi evenimentul `checkout.session.completed`, copiezi `STRIPE_WEBHOOK_SECRET`.
- **TVA**: `automatic_tax` e dezactivat explicit in cod (`enabled: false`) — sole trader UK, neinregistrat TVA momentan. Cand te inregistrezi, activezi Stripe Tax din Dashboard SI schimbi valoarea in `server.js` (cauta `automatic_tax`).

### 3. Provider API de muzica — NECESITA CONFIRMAREA TA
Nu exista API oficial public Suno inca. Codul din `server.js` (functia `callMusicProvider`) e o **structura generica**, nu o integrare verificata cu un provider real — inainte de lansare trebuie sa confirmi exact:
- Providerul ales (sunoapi.org / apiframe.ai / aimlapi.com / altul) si `MUSIC_API_BASE_URL` lui exact.
- Numele exact al campurilor din request (stil muzical, versuri) si din raspuns (id task, url audio, valorile posibile pentru status).
- Daca providerul returneaza deja 2 clipuri per apel (comun la Suno) — daca da, codul actual apeleaza de 2 ori si plateste de 2 ori degeaba, trebuie adaptat sa desparta cele 2 URL-uri dintr-un singur raspuns.

Comentariile din jurul functiei `callMusicProvider()` din `server.js` detaliaza exact fiecare intrebare. Fara raspunsuri la ele, generarea de melodii poate esua sau poate costa dublu fata de cat trebuie.

### 4. Email de livrare — Resend
1. Cont pe resend.com, verifici un domeniu (Settings -> Domains) — fara domeniu verificat, poti trimite doar de pe `onboarding@resend.dev`, valabil pentru testare, nu pentru productie.
2. Generezi un API key -> `RESEND_API_KEY`.
3. Adresa de trimitere verificata -> `RESEND_FROM_EMAIL`.

Fara `RESEND_API_KEY`, emailul nu pleaca, dar nimic nu se blocheaza — clientul tot poate lua melodia din pagina de succes sau din `/comanda-mea.html` cu codul lui de acces.

### 5. Configurare locala
```
cp .env.example .env
# completeaza toate valorile in .env
npm install
npm start
```
Site-ul ruleaza pe `http://localhost:3000`.

### 6. Deploy pe Railway
1. Urci proiectul pe GitHub (repo privat).
2. In Railway: **New Project -> Deploy from GitHub repo**.
3. Adaugi serviciul PostgreSQL (pasul 1 de mai sus) in acelasi proiect.
4. In Variables, adaugi toate valorile din `.env.example` (mai putin `DATABASE_URL`, care vine automat de la serviciul Postgres).
5. Actualizezi `DOMAIN` cu URL-ul generat de Railway, si actualizezi webhook-ul din Stripe cu acelasi domeniu.

## Securitate — ce s-a schimbat pentru productie

- **Comanda mea, prin cod unic**: `/comanda-mea.html` nu mai cauta dupa email — cautarea dupa email ar fi permis oricui stie adresa cuiva sa-i vada toate comenzile si povestile private. Acum se foloseste un `accessToken` de 48 caractere hex, generat aleator la fiecare comanda, trimis doar prin emailul de livrare.
- **Pretul se calculeaza pe server**, niciodata din datele trimise de client. Inainte, `price` venea direct din formular — cineva care modifica cererea (devtools/curl) putea plati mai putin decat pretul real. Acum serverul recalculeaza pretul dupa pachetul ales (`standard`/`premium`/`video`), indiferent ce trimite clientul.
- **Validare stricta** pe toate campurile din formular: email cu format valid, lungimi minime/maxime pe poveste si nume, valori permise explicit pentru ocazie/gen/pachet/limba — orice altceva e respins cu eroare clara, nu procesat orbeste.
- **Rate limiting** pe crearea de comenzi si pe generare (max 20, respectiv 15 cereri la 15 minute per IP) — previne abuzul asupra generarii gratuite de preview-uri, care costa bani la fiecare apel catre API-ul de muzica.
- **Parola de admin** comparata cu `crypto.timingSafeEqual`, nu cu `===` simplu — evita scurgeri de informatie prin timpul de raspuns.
- **Headere de securitate** (helmet) pe toate raspunsurile. CSP (Content-Security-Policy) e dezactivat explicit — paginile folosesc script/stil inline, o politica stricta le-ar rupe fara o refactorizare separata a codului in fisiere externe. Ramane un punct de imbunatatit ulterior.
- **Nicio cheie sau parola in cod** — toate (Stripe, Resend, API muzica, admin) vin exclusiv din variabile de mediu. Serverul refuza sa porneasca daca lipsesc cele obligatorii (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `DOMAIN`, `DATABASE_URL`, `ADMIN_USER`, `ADMIN_PASSWORD`), cu eroare clara in log, nu esec silentios.
- **Gestionare erori completa**: fiecare rută are try/catch, un handler central de erori raspunde curat in loc sa lase serverul sa cada, apelurile catre servicii externe (API muzica, Resend) au timeout explicit ca sa nu blocheze cererile la nesfarsit daca serviciul extern nu raspunde.

## Ce ramane de facut inainte de lansare reala

- **Confirmi providerul de muzica exact** (vezi sectiunea 3 de mai sus) — fara asta, generarea poate esua sau costa dublu.
- ~~Volum persistent pentru fisierele audio~~ — **rezolvat.** Fisierele audio ale comenzilor merg acum in Cloudflare R2 / AWS S3, daca ai configurat variabilele `S3_*` (vezi sectiunea dedicata mai jos). Fara ele configurate, aplicatia ramane pe fallback-ul vechi (disc local, cu acelasi risc de pierdere la redeploy pe Railway fara Volume) — dar acum e o alegere explicita a ta, nu singura optiune.
- **Termeni si conditii + politica de rambursare** — obligatoriu legal pentru comert online in UK. Melodia e generata AI — clarifica explicit ce drepturi primeste clientul asupra fisierului.
- **CSP propriu-zis**: headerele de securitate de baza sunt active, dar Content-Security-Policy e dezactivat din cauza script-urilor inline. O versiune mai stricta ar necesita mutarea JS-ului din paginile HTML in fisiere `.js` separate, cu nonce — refactorizare vizuala zero, dar structurala, nu am facut-o fara sa confirmi ca o vrei.
- **Facturare fiscala** — integrare cu un serviciu de facturare (ex: QuickBooks, Xero) pentru facturi automate la fiecare comanda platita.

## Costuri reale per comanda (estimativ, verifica la providerul ales)

- Generare melodie: de la 0.08 USD/generare la providerii mentionati — cu 2 variante per runda, dubleaza costul per lead fata de o singura varianta.
- Comision Stripe UK: ~1.5% + £0.20 per tranzactie card UK/UE, ~2.5% + £0.20 pentru carduri non-UE.
- Marja neta la pretul de £15: peste 85%, chiar si cu 2 variante per runda.

## Stocare cloud pentru fisiere media (R2 / S3) — doua bucket-uri separate

Toate fisierele media — melodiile complete, preview-urile, si materialele din "Reactii clienti" (poze/video/audio) — pot fi stocate profesional in Cloudflare R2 sau AWS S3, in loc de discul local al serverului. Rezolva definitiv riscul de pierdere a fisierelor la redeploy pe Railway si permite scalare fara limita de spatiu pe disc.

**De ce doua bucket-uri, nu unul singur**: daca ai un singur bucket cu tot continutul si activezi acces public pe el (necesar pentru preview-uri si testimoniale), *tot* bucket-ul devine potential accesibil prin acel domeniu — inclusiv melodiile complete, daca cineva ar afla vreodata cheia exacta a unui fisier. Cu doua bucket-uri, separarea e structurala:

- **`naluna-private`** — doar melodiile complete (`orders/full/...`). Fara acces public, niciodata. Acces exclusiv prin URL semnat (presigned), generat la cerere, dupa ce codul verifica in baza de date ca ai fost platit.
- **`naluna-public`** — preview-uri (`orders/preview/...`) si reactii clienti (`testimonials/...`). Acces public, prin Custom Domain Cloudflare.

`storage.js` are functii separate pentru fiecare (`uploadPrivateFile` / `uploadPublicFile`, `deletePrivateFile` / `deletePublicFile`) — structural, nu exista nicio cale prin care codul sa trimita din greseala un fisier privat in bucket-ul public.

**Cum functioneaza**: daca toate variabilele `S3_*` din `.env` sunt completate, `storage.js` le foloseste automat pentru orice fisier nou. Daca lipsesc (chiar si una singura), aplicatia foloseste discul local ca fallback complet — nimic nu se blocheaza daca nu le configurezi imediat, dar pe Railway, in productie, sunt puternic recomandate.

**De ce R2 in loc de S3**: Cloudflare R2 nu factureaza trafic de iesire (egress) — pentru un site care serveste audio si video, asta poate insemna o diferenta reala de cost pe termen lung fata de S3, care taxeaza fiecare GB descarcat de utilizatori. Recomandarea mea e R2, dar codul functioneaza identic cu oricare dintre ele (acelasi SDK, S3 e compatibil cu API-ul R2).

### Setup Cloudflare R2
1. dash.cloudflare.com -> R2 Object Storage -> **Create bucket**, de doua ori: `naluna-private` si `naluna-public`.
2. R2 -> Overview -> Manage API Tokens -> Create API token -> permisiuni **Object Read & Write** -> scop **Apply to specific buckets only** -> selectezi **ambele** bucket-uri (acelasi token poate avea acces la amandoua). Copiezi Access Key ID si Secret Access Key — apar o singura data.
3. **Doar pe `naluna-public`**: Settings -> Public Access -> Custom Domains -> Connect Domain (ex: `media.naluna.co.uk`). **Pe `naluna-private` nu activezi niciun fel de acces public, niciodata.**
4. Endpoint-ul (acelasi pentru tot contul, indiferent de bucket) il gasesti in Settings -> sectiunea "S3 API", pe oricare din cele doua bucket-uri.
5. Completezi in `.env`:
   ```
   S3_PRIVATE_BUCKET=naluna-private
   S3_PUBLIC_BUCKET=naluna-public
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_PUBLIC_BASE_URL=https://media.naluna.co.uk
   ```

### Setup AWS S3 (alternativa)
1. S3 -> Create bucket, de doua ori: `naluna-private` si `naluna-public`, aceeasi regiune (ex: `eu-west-2` pentru UK)
2. IAM -> Create user -> policy limitata la PutObject/GetObject/DeleteObject pe ambele bucket-uri
3. **Doar pe `naluna-public`**: pui CloudFront in fata lui (recomandat — cache + HTTPS), URL-ul CloudFront merge la `S3_PUBLIC_BASE_URL`. `naluna-private` ramane fara niciun acces public configurat.
4. Completezi in `.env`:
   ```
   S3_PRIVATE_BUCKET=naluna-private
   S3_PUBLIC_BUCKET=naluna-public
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   S3_REGION=eu-west-2
   S3_ENDPOINT=
   S3_PUBLIC_BASE_URL=https://d111111abcdef8.cloudfront.net
   ```

### Ce se intampla cu fiecare tip de fisier
- **Melodia completa** — urcata in `naluna-private`. `/media/full/:orderId` verifica intai ca ai platit (`status === 'ready'`), apoi genereaza un URL semnat, valabil 10 minute, si redirectioneaza browser-ul catre el. Bandwidth-ul de livrare vine direct din R2/S3, nu trece prin serverul tau.
- **Preview-ul** — urcat in `naluna-public`, URL public direct, fara nicio restrictie (era deja gratuit de ascultat).
- **Testimoniale** — la fel, `naluna-public`, URL public direct.

### Migrarea fisierelor existente
Daca ai deja comenzi sau reactii salvate pe disc local (din perioada fara stocare cloud) si activezi acum `S3_*`, fisierele VECHI raman pe disc si nu se muta automat — doar fisierele NOI, generate dupa activare, merg in cloud. Pentru un site abia lansat, cel mai simplu e sa activezi stocarea cloud chiar de la inceput, inainte de primele comenzi reale.

## Reactii clienti (testimoniale)

Sectiune noua, gestionata exclusiv din `/admin` — nu exista formular public de upload, clientii nu pot trimite singuri continut.

- **Ce poate face admin-ul**: adauga o reactie (prenume, oras/tara, citat, tip — text/imagine/video/audio), o publica sau o ascunde, ii schimba ordinea (sageti sus/jos), o editeaza sau o sterge.
- **Consimtamant obligatoriu**: nu se poate salva nicio reactie fara sa bifezi explicit "Confirm ca am acordul clientului" — validat si pe server, nu doar in formular (cineva care ar incerca sa ocoleasca formularul direct prin API tot ar fi respins).
- **Homepage**: sectiunea "Reactii reale de la clienti" e complet ascunsa daca nu exista nicio reactie publicata — nu arata niciodata goala. Afiseaza maxim 6, in ordinea stabilita de tine.
- **Video incarcat doar la click**: fisierul video NU are `src` la incarcarea paginii — se seteaza abia cand cineva apasa play. Am verificat explicit (test automat): zero cereri de retea catre fisierul video inainte de click, exact una dupa. Imaginile folosesc `loading="lazy"`, iar audio foloseste `preload="none"` — niciuna nu incetineste incarcarea initiala a paginii.
- **Fisierele** merg direct in Cloudflare R2 / AWS S3, daca ai configurat stocarea cloud (vezi sectiunea dedicata mai jos). Fara ea configurata, folosesc acelasi fallback local ca fisierele audio ale comenzilor — cu acelasi risc de disc efemer pe Railway.
- **Limite fisiere**: max 60MB per fisier, tipuri acceptate: imagini (jpg/png/webp), video (mp4/webm), audio (mp3/wav/m4a) — validate atat dupa extensie cat si dupa tipul real MIME.

## Identitate vizuala — NALUNA

Rebranding complet fata de versiunea anterioara ("Nota de Suflet"). Nicio functionalitate nu s-a schimbat — doar culori, tipografie, logo.

- **Paleta**: fundal `#FAF8F5` / `#F8F6F2`, text `#2B2B2B` / `#6B6B6B`, accent auriu `#A8834B` (fara galben intens, fara alb pur nicaieri).
- **Logo**: `public/logo.svg` (versiunea completa, folosita in header/footer) si `public/favicon.svg` (versiune simplificata, optimizata pentru 16-32px). Ambele sunt vectoriale, clare la orice dimensiune.
- **Imagine social sharing**: `public/og-image.png` (1200×630), generata din acelasi sistem vizual, legata prin meta tag `og:image` in `index.html`.
- **Tipografie**: Fraunces (titluri, elegant/editorial) + Sora (text, UI). Am renuntat la fontul monospace folosit inainte pentru etichete — nu se potrivea cu directia de lux discret ceruta.
- **Semnatura vizuala a hero-ului**: luna din logo, cu sclipire animata si o usoara plutire — inlocuieste vechea animatie cu vinil care se invarte. Respecta `prefers-reduced-motion`.
- Daca vrei sa ajustezi nuanta de auriu sau spatierea, cauta `:root` in `<style>`-ul din `public/index.html` — toate paginile folosesc acelasi set de variabile.

## Note tehnice

- **8 limbi** — romana, engleza, germana, spaniola, italiana, franceza, bulgara, turca. Traducerile sunt in obiectul `translations` din `public/index.html` (cauta `const translations = {`), plus dictionare mai mici in `succes.html` si `comanda-mea.html`. Emailul de livrare vine automat in limba selectata de client la comanda.
- **UK-only, tehnic, nu doar declarativ**: `shipping_address_collection: { allowed_countries: ['GB'] }` in sesiunea Stripe Checkout — desi produsul e digital, campul de "livrare" e refolosit ca filtru de tara, clientul nu poate finaliza plata daca nu selecteaza UK.
- **Teme**: formularul are 8 teme (dor, onomastica, aniversare, declaratie, nunta, pierdere, pentru mine, altceva). Fiecare influenteaza promptul trimis catre AI prin `buildPrompt()` din `server.js`.
