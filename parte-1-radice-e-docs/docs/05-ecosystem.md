# 05 — Racing Team Ecosystem: Admin + App

Piano di implementazione per i due prodotti collegati. Stato aggiornato in fondo (§9): **solo ciò che è elencato come "Costruito" funziona e ha test.**

## 1. Due prodotti, un backend

| | **Racing Team Admin** | **Racing Team App** |
| --- | --- | --- |
| Per chi | Amministratori e responsabili di team | Membri, studenti, collaboratori |
| Percorso | `/admin/**` | `/app/**` |
| Navigazione | Barra laterale densa a gruppi (Centro di comando, Team, Persone, Sondaggi, Calendari, Chat, Progetti, Documenti, Report, Impostazioni, Audit) | Mobile-first: barra inferiore su telefono, barra laterale compatta su desktop (Home, Chat, Calendario, Team, Riunioni, Documenti, Notifiche, Profilo) |
| Accesso | Permesso `admin.access` | Qualunque membro attivo |
| Identità visiva | Strumento professionale, tabelle e filtri | Leggero, a schede, orientato al telefono |

**Stesso codice, stessa base dati, stessa sessione, stesso motore dei permessi.** Sono due *route group* di Next.js con layout e shell indipendenti (nessun componente di navigazione condiviso). Separarli su due domini è possibile con un rewrite per host; non è costruito.

**Regola di sicurezza:** `/admin` non si protegge solo nel layout. Ogni pagina, azione e funzione del DAL richiama `requireAdminAccess()` / verifica `admin.access`; i layout non si rieseguono a ogni navigazione. Un membro che apre `/admin/...` viene reindirizzato a `/app`; una chiamata diretta a un'azione admin viene rifiutata dal server (test).

## 2. Modello organizzativo e permessi

```
Organizzazione
 ├─ Amministratori      (ruoli super_admin, org_admin  → admin.access = all)
 ├─ Team                (ogni team: chat, calendario, sondaggi, documenti, progetti)
 │   ├─ Responsabile     (team_members.role = lead; ruolo piattaforma team_admin → admin.access = scoped ai propri team)
 │   └─ Membri           (una persona può stare in più team)
 └─ Progetti, task, documenti (visibilità org / team / privato)
```

- **`admin.access`** (nuovo permesso): `super_admin` e `org_admin` = *all*; `team_admin` = *scoped* (vede in Admin solo i propri team); gli altri ruoli = nessuno. È incluso nella tabella di `01-product-spec.md`, controllata da test.
- **Isolamento per team:** calendari, chat, sondaggi e documenti di un team sono leggibili solo da chi appartiene a quel team (o è amministratore con scope sufficiente). L'appartenenza si rilegge dal database a ogni richiesta (un membro rimosso perde subito l'accesso).
- **Chat riservate agli admin:** le conversazioni `admin_group` / `admin_direct` ammettono solo persone con `admin.access`, verificato **sia all'aggiunta sia a ogni lettura** (un admin declassato non legge più nulla). I membri non le vedono né le possono indovinare (risposta "non trovato").

## 3. Estensioni del database (migrazioni, additive)

| Migrazione | Contenuto |
| --- | --- |
| 0006 | Profili utente (avatar, contatti, preferenze, privacy), `team_members.title` (ruolo nel team), categorie di evento |
| 0007 | `calendars` (admin condiviso / team), permessi del calendario, `events` con ricorrenza, partecipanti con RSVP e presenza, promemoria, eccezioni di occorrenza |
| 0008 | `meeting_polls`, `poll_options`, `poll_votes`, `poll_attendance`, ricorrenza settimanale |
| 0009 | `conversations`, `conversation_members`, `messages`, `attachments`, `message_reactions`, fissati, sticker, blocchi, richieste di messaggio |
| 0010 | `documents` / versioni / ACL, impostazioni di archiviazione |
| (già fatte) 0004–0005 | Progetti, task, stati, workflow, campi, milestone, dipendenze, commenti, notifiche, viste, ricerca FTS5, inviti |

Tutte le chiavi tra tabelle di tenant sono composte `(id, org_id)`: un riferimento tra organizzazioni è impossibile a livello di database.

## 4. Tempo reale

**Architettura:** Server-Sent Events da un route handler (`GET /api/realtime`) + un bus di eventi **in-process**, coerente con l'architettura a istanza singola scelta (ADR-2). Nessuna libreria WebSocket, nessun servizio esterno.

- Il server pubblica **solo dopo il commit** della transazione che ha cambiato il dato, con payload minimo (tipo + id). Il client ricarica il dato dagli endpoint autorizzati: l'evento non trasporta mai contenuti.
- Ogni connessione SSE è legata a una sessione valida; l'instradamento filtra per destinatari autorizzati (membri della conversazione/team) **al momento della consegna**.
- **Presenza e "sta scrivendo"** sono effimere (memoria del processo, scadenza a tempo): nessun dato personale su disco. La presenza è visibile solo a chi condivide un team o una conversazione e solo se l'utente non l'ha disattivata.
- Ripiego: se SSE cade, il client ricarica periodicamente; lo stato non dipende dal canale live.
- **Limite dichiarato:** funziona con un solo processo Node. Con più istanze servirebbe un bus condiviso (es. Redis/Postgres LISTEN); è il punto di uscita già previsto in ADR-2.

## 5. Media e allegati

- Upload `POST /api/uploads` (multipart): limiti di dimensione per tipo, **lista consentita di MIME + controllo dei magic byte**, nome originale solo come metadato, chiave di storage casuale; file su disco in `STORAGE_DIR` (fuori da `public/`).
- Accesso `GET /api/media/[id]`: autorizza con la stessa regola della conversazione/documento di appartenenza; `Content-Disposition` e `nosniff`; SVG e HTML mai inline.
- Client: compressione/ridimensionamento delle immagini con canvas prima dell'invio, avanzamento con `XMLHttpRequest`, registrazione vocale con `MediaRecorder`, riproduzione con controlli.
- **Non costruito / da configurare:** ricerca GIF (Tenor/Giphy richiedono chiavi: stato disattivato), scansione antivirus, miniature video lato server. Le GIF caricate come file funzionano come immagini.

## 6. Ordine di costruzione

1. **Piattaforma** — permesso `admin.access`, shell Admin e shell App separate, redirect dai vecchi `/admin`/`/member`.
2. **Team** — creazione/modifica, responsabili, ruoli nel team, membri, appartenenze multiple, statistiche.
3. **Calendari** — admin condiviso + team, viste mese/settimana/giorno/agenda/elenco, ricorrenza, partecipanti, promemoria.
4. **Sondaggi di riunione + presenze** (funzione critica) — creazione, voto, risultati, conferma, evento automatico, notifiche.
5. **Chat** — gruppi admin, gruppi di team, diretti, media, reazioni, ricevute di lettura, tempo reale.
6. **Centro di comando Admin + Home App**.
7. **Documenti, report, analytics, impostazioni di sistema**, poi progetti/task UI e automazioni.

## 7. Ruoli di riferimento (invariati)

Super Admin, Admin organizzazione, Team Admin (responsabile), Project Manager, Membro, Viewer — matrice in `01-product-spec.md`.

## 8. Dichiarazioni oneste

- "Online" = connessione SSE attiva negli ultimi secondi, non una garanzia.
- Le notifiche push del browser/telefono (Web Push) **non** sono costruite: richiedono chiavi VAPID e un service worker.
- Le email non partono finché non c'è un SMTP configurato (stato *Da configurare*).

## 9. Inventario delle funzionalità (stato reale)

**Costruito** = funziona, ha logica server, dati persistenti, controllo dei permessi e test. **Parziale** = esiste una parte; la lacuna è scritta. **Non costruito** = nessun codice (non c'è un pulsante finto).

### Racing Team ADMIN

| Modulo | Stato | Dettaglio |
| --- | --- | --- |
| Centro di comando | **Costruito** | KPI calcolati dai dati nell'ambito di chi guarda (team, membri, progetti, riunioni 7 gg, sondaggi aperti, candidature, presenze 30 gg, completamento compiti); prossimi eventi; sondaggi da gestire; conversazioni recenti; attività; notifiche. Un team admin vede solo il proprio team |
| Team | **Costruito** | Crea/modifica/elimina (logico), gerarchia, responsabili, membri con ruolo e titolo, appartenenze multiple, statistiche, spazio di lavoro con schede. *Non costruito:* documenti e progetti del team (nessuna scheda) |
| Sondaggi di riunione | **Costruito** | Creazione con opzioni, tipo, luogo, link, scadenza, ricorrenza settimanale; pubblicazione (fotografa gli invitati e notifica); risultati live (SSE); classifica, giorno/ora preferiti, non rispondenti; presenza dichiarata; **conferma solo da parte di un amministratore** → evento nel calendario del team + notifiche + risposte di presenza importate. *Non costruito:* modifica di una bozza da interfaccia (esiste `updatePoll` nel core), eliminazione |
| Calendari | **Costruito** | Calendario amministratori + uno per team; viste mese/settimana/giorno/agenda/elenco; filtri e ricerca; categorie/colori; ricorrenza (giorno/settimana/mese, intervallo, giorni, fine); annullo di una data; invitati; promemoria (scheduler); RSVP per occorrenza; presenze effettive; scadenze personali. Permessi del calendario nel core. *Non costruito:* interfaccia dei permessi del calendario, allegati agli eventi, ICS, sincronizzazione Google/Microsoft |
| Chat | **Costruito (API completa)**; interfaccia **parziale** | Gruppi riservati agli admin (creazione), chat di team, annunci, diretti con richieste e blocchi; testo, immagini multiple, note vocali, video/PDF/Office/TXT/CSV, sticker (emoji grandi), reazioni, risposte, inoltro, fissati, modifica/eliminazione con finestre di tempo, ricevute di lettura, "sta scrivendo", presenza (nell'intestazione dei diretti), non lette, ricerca nei messaggi, silenzia, filtri, paginazione. *Non costruito nell'interfaccia:* rinomina/descrizione/foto del gruppo, aggiunta e rimozione dei membri/admin (esistono nel core e nell'API), elenco "online" generale. *Non costruito:* ricerca GIF (richiede chiavi), anteprime dei link |
| Compiti | **Parziale** | Pagina «Compiti» sul progetto «Attività del team»: tabella, filtri, creazione, cambio di stato con errori di workflow/dipendenze mostrati accanto alla riga. Il **motore** (core) è completo e testato — stati e workflow configurabili, campi personalizzati, milestone, sottotask, dipendenze senza cicli, spostamento su board, azioni di gruppo, filtri/ordinamenti, commenti e menzioni, notifiche, ricerca FTS5 — ma **le viste Board/Calendario/Timeline/Gantt, le impostazioni di progetto, le viste salvate, l'import/export CSV e la panoramica di progetto non hanno ancora un'interfaccia** |
| Persone (membri) | **Parziale** | Elenco per reparto e creazione account (pagina storica). *Non costruito:* modifica del ruolo, sospensione, inviti (tabella `invitations` pronta, nessun flusso) |
| Notifiche | **Costruito** | Centro, non lette, segna come lette, preferenze per categoria, contatori live. Email e push **non** attive |
| Registro attività | **Costruito** | Filtri per tipo e data, paginazione, voci non modificabili. *Non costruito:* export |
| Impostazioni | **Parziale** | Regole della chat (finestre di modifica/eliminazione, dimensione file, DM) e stato onesto delle integrazioni. *Non costruito:* impostazioni di calendario, sondaggi, notifiche, archiviazione |
| Ruoli e permessi | **Parziale** | Matrice di default testata contro la documentazione; deroghe per organizzazione nel database e nel core. **Nessun editor** nell'interfaccia |
| Ricerca globale + ⌘K | **Costruito** | Progetti, task e persone, con visibilità applicata nella stessa query. *Non costruito:* eventi, messaggi, documenti |
| Documenti, Report/Analytics avanzata, Automazioni, Racing AI, import/export, strumenti dati | **Non costruito** | Nessun codice. Il piano è in `04-roadmap.md` |

### Racing Team APP

| Sezione | Stato | Dettaglio |
| --- | --- | --- |
| Home | **Costruito** | Prossime riunioni (con la mia risposta), sondaggio da compilare, annunci, miei compiti, attività del team, messaggi recenti, notifiche |
| Chat | **Costruito** | Come sopra, per le conversazioni a cui si ha accesso |
| Calendario | **Costruito** | Agenda e altre viste, RSVP, scadenze personali |
| Team | **Costruito** | I miei team e i loro membri (contatti nascosti ai colleghi) |
| Riunioni | **Costruito** | Voto mobile-first (Sì/Forse/No, opzione preferita), **«Sono presente» / «Non sono presente»** (+ «Forse»), nota, conferma finale con aggiornamento presenza |
| Notifiche | **Costruito** | |
| Profilo | **Costruito** | Foto, contatti (solo admin), presentazione, privacy (presenza, chi può scrivermi), preferenze notifiche, password, esci |
| Documenti | **Non costruito** | La voce non compare nella navigazione |

### Tempo reale

| Evento | Stato |
| --- | --- |
| Nuovi messaggi, reazioni/modifiche/eliminazioni, ricevute di lettura, "sta scrivendo" | **Costruito** (SSE) |
| Voti e presenze dei sondaggi, conferma, modifiche al calendario, notifiche, appartenenza ai team | **Costruito** (SSE) |
| Presenza online | **Parziale**: stato "online/offline/nascosto" nell'intestazione dei diretti; nessun elenco generale |

## 10. Cosa è stato verificato e cosa no

**Verificato con test automatici (207):** regole di accesso e isolamento tra team e organizzazioni, ricorrenze, sondaggi (voto, scadenza, risultati, conferma, ricorrenza), calendari (permessi, RSVP, presenze, promemoria), chat (accessi, admin declassato, blocchi, richieste, finestre di modifica, reazioni, inoltro, lettura, paginazione), validazione dei file con magic number, presenza/privacy, dashboard con ambito, profilo, registro attività, manutenzione periodica, tempo reale solo dopo il commit.

**Verificato a mano nel browser (build di produzione, database di prova):** accesso come membro e come responsabile di team; voto e presenza dal telefono; risultati live; conferma → evento, notifica e risposte di presenza nel database; isolamento delle API con la sessione di un membro (18 conversazioni su 20 rifiutate, media 404, origine falsificata 403, membro che crea un gruppo admin 403); eventi SSE reali (`message.created`, `message.updated`); upload reale di un PNG, download con `nosniff`/CSP/Range (206); rifiuto di HTML, SVG, eseguibile e TXT con markup; rendering di calendario e chat.

**NON verificato:** registrazione di una nota vocale con il microfono e la sua riproduzione (il percorso `MediaRecorder` esiste ma non è stato esercitato: nessun microfono nell'ambiente di prova); compressione delle immagini lato browser (canvas) attraverso l'interfaccia; invio dei messaggi digitando nell'interfaccia (verificato l'API e il rendering); due utenti contemporaneamente con SSE (verificato che gli eventi raggiungano una sessione, e nei test che raggiungano solo i destinatari giusti); Safari/Firefox; telefoni reali; carico; `next dev`.
