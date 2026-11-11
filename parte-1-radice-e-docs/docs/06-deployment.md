# 06 — Messa in produzione su Google Cloud

> **Stato onesto.** Questa guida porta Racing Team da «gira sul mio Mac» a «ha un indirizzo HTTPS permanente su una macchina Google».
> **Provato in locale** (2026-11-08): build di produzione; avvio con `NODE_ENV=production` su un database nuovo; creazione del primo
> Super Admin con lo script e accesso a `/admin`; sospensione e reset password; backup con controllo di integrità; header di sicurezza.
> **NON provato:** la creazione della VM, il DNS, Caddy, il certificato, il servizio systemd, il backup su Cloud Storage e la
> procedura di ripristino su Google Cloud. I comandi sono scritti con cura ma nessuno è stato eseguito su Google Cloud: alla prima
> installazione leggi l'output di ogni passo e, se un comando fallisce, correggi prima di andare avanti.

## 0. Perché una VM (e non Cloud Run, Firebase o Cloudflare)

L'app salva i dati in **un file SQLite** e i file caricati su **disco**, e il tempo reale (chat, presenza) usa un bus **in memoria di un
solo processo** (ADR-2, `docs/02-architecture.md`). Serve quindi **una sola istanza con un disco persistente**: una macchina virtuale
(Compute Engine). Servizi che avviano più istanze o hanno un disco temporaneo (Cloud Run, App Engine standard, Firebase Hosting,
Workers) perderebbero i dati o romperebbero la chat. Se in futuro serviranno più istanze, il passo è PostgreSQL + storage a oggetti.

```
Utenti ──HTTPS──▶ Caddy (certificato automatico, :443)
                    └──▶ Next.js su 127.0.0.1:3000  (solo locale: da fuori non è raggiungibile)
                            └──▶ /var/lib/racing-team/racing.db  +  storage/   (disco persistente)
```

## 1. Cosa decidere prima

| Decisione | Consiglio |
| --- | --- |
| **Dominio** | Serve un nome (es. `team.tuodominio.it`) con un record DNS A verso la VM. Un dominio si compra da qualsiasi registrar; in alternativa chiedi al referente IT del dipartimento se esiste un sottodominio dell'ateneo (non si assume nessuna integrazione con UniPG). Senza dominio un certificato valido non è realistico: `<ip>.sslip.io` va bene solo per una prova, non per l'uso reale. |
| **Regione** | UE, vicino agli utenti: `europe-west8` (Milano) o `europe-west12` (Torino). Verifica la disponibilità nel tuo progetto. |
| **Dimensione VM** | `e2-medium` (4 GB di RAM): `next build` consuma parecchia memoria e con 1–2 GB può fallire. Dopo la build la macchina è quasi inattiva. Controlla i prezzi con il Pricing Calculator e imposta un **avviso di budget**. |
| **Dati personali** | L'app tratta nomi, email, foto, contatti, presenze e chat, anche di studenti. Prima di invitare i membri servono **un'informativa privacy**, un titolare del trattamento chiaro e (se l'ateneo lo richiede) un'autorizzazione. Verifica il *Data Processing Addendum* di Google Cloud. Non è una consulenza legale: chiedi a chi è responsabile. |

## 2. Passo per passo

### A. Il codice su un repository privato

Il repository oggi è solo sul tuo Mac (nessun `remote`). Crea un repository **privato** su GitHub e spingi il branch. I dati non partono:
`data/` è ignorato da git (`git ls-files data` deve restare vuoto).

```bash
git remote add origin git@github.com:TUO-ACCOUNT/racing-team.git
git push -u origin feat/recent-team-foundation
```

Prima di pubblicare, imposta il nome vero dell'autore dei commit (oggi è un segnaposto). Il database locale `data/racing.db` **non va portato in
produzione**: contiene gli utenti dimostrativi con password note. Si parte da un database nuovo (passo F).

### B. Progetto Google Cloud

1. Console Google Cloud → nuovo progetto → collega un account di fatturazione.
2. **Fatturazione → Budget e avvisi**: crea un budget con avvisi via email.
3. Installa `gcloud` sul Mac (cloud.google.com/sdk) e accedi:

```bash
gcloud auth login
gcloud config set project ID_DEL_PROGETTO
gcloud services enable compute.googleapis.com
```

### C. Macchina, IP fisso, firewall

```bash
REGION=europe-west8; ZONE=europe-west8-b

gcloud compute addresses create racing-team-ip --region=$REGION

gcloud compute instances create racing-team \
  --zone=$ZONE --machine-type=e2-medium \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced \
  --address=racing-team-ip --tags=web \
  --metadata=enable-oslogin=TRUE \
  --scopes=storage-rw,logging-write,monitoring-write

# Il mondo può raggiungere solo 80 e 443.
gcloud compute firewall-rules create racing-team-web --allow=tcp:80,tcp:443 --target-tags=web

# SSH: niente porta 22 aperta a tutti. Si entra tramite Identity-Aware Proxy.
gcloud compute firewall-rules create racing-team-ssh-iap --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=web
gcloud compute firewall-rules delete default-allow-ssh     # se esiste nella rete "default"

gcloud compute addresses describe racing-team-ip --region=$REGION --format='value(address)'   # → l'IP da usare nel DNS
gcloud compute ssh racing-team --zone=$ZONE --tunnel-through-iap
```

Uno snapshot giornaliero del disco è un secondo livello di protezione (oltre ai backup del passo K):

```bash
gcloud compute resource-policies create snapshot-schedule racing-team-daily \
  --region=$REGION --max-retention-days=14 --daily-schedule --start-time=02:00
gcloud compute disks add-resource-policies racing-team --zone=$ZONE --resource-policies=racing-team-daily
```

### D. DNS

Dal pannello del registrar crea un record **A**: `team.tuodominio.it` → IP della VM. Verifica (può servire qualche minuto):

```bash
dig +short team.tuodominio.it
```

### E. Software sulla VM (dopo `gcloud compute ssh`)

```bash
sudo apt-get update && sudo apt-get install -y git xz-utils unattended-upgrades

# Node 24 dal sito ufficiale, con controllo SHA-256. Usa l'ultima 24.x LTS indicata su nodejs.org.
NODE_VER=24.22.2
cd /tmp
curl -fsSLO https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v$NODE_VER/SHASUMS256.txt
grep " node-v$NODE_VER-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -        # deve stampare: OK
sudo mkdir -p /opt/node && sudo tar -xJf node-v$NODE_VER-linux-x64.tar.xz -C /opt/node --strip-components=1
sudo ln -sf /opt/node/bin/node /usr/local/bin/node && sudo ln -sf /opt/node/bin/npm /usr/local/bin/npm
node -v        # v24.x
```

**Caddy** (web server con certificato HTTPS automatico): installalo seguendo la guida ufficiale per Ubuntu, <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>.

Utente di servizio e cartelle (i dati stanno **fuori** dal codice):

```bash
sudo useradd --system --create-home --home-dir /opt/racing-team --shell /usr/sbin/nologin racingteam
sudo install -d -o racingteam -g racingteam -m 700 /var/lib/racing-team /var/lib/racing-team/storage /var/backups/racing-team
```

### F. Codice, configurazione, primo amministratore, build

Chiave di sola lettura per clonare il repository privato:

```bash
sudo -u racingteam ssh-keygen -t ed25519 -N "" -f /opt/racing-team/.ssh_deploy_key
sudo cat /opt/racing-team/.ssh_deploy_key.pub      # incollala in GitHub → repository → Settings → Deploy keys (senza scrittura)
sudo -u racingteam GIT_SSH_COMMAND="ssh -i /opt/racing-team/.ssh_deploy_key -o StrictHostKeyChecking=accept-new" \
  git clone -b feat/recent-team-foundation git@github.com:TUO-ACCOUNT/racing-team.git /opt/racing-team/app
```

Configurazione (`/etc/racing-team.env`, leggibile solo da root e dal servizio):

```bash
sudo tee /etc/racing-team.env >/dev/null <<'EOF'
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
DATABASE_FILE=/var/lib/racing-team/racing.db
STORAGE_DIR=/var/lib/racing-team/storage
# La compressione la fa Caddy (escludendo il tempo reale): quella di Next si spegne.
NEXT_COMPRESS=false
EOF
sudo chown root:racingteam /etc/racing-team.env && sudo chmod 640 /etc/racing-team.env
```

Installazione, **primo amministratore** (crea anche il database e applica le migrazioni) e build. L'ordine conta: il database nasce da un solo processo, poi la build lo trova già pronto.

```bash
sudo -u racingteam bash -c '
  set -euo pipefail; set -a; . /etc/racing-team.env; set +a
  cd /opt/racing-team/app
  npm ci
  npm run admin:create -- --name "Nome Cognome" --email tua@email.it
  npm run build
'
```

Lo script **stampa una volta sola** la password generata: salvala subito in un gestore di password. Se preferisci sceglierla tu, esporta `ADMIN_PASSWORD` (almeno 12 caratteri) prima del comando; non passarla mai come argomento. Dopo il primo accesso cambiala da **Profilo**.

### G. Servizio sempre attivo (systemd)

```bash
sudo tee /etc/systemd/system/racing-team.service >/dev/null <<'EOF'
[Unit]
Description=Racing Team
After=network.target

[Service]
User=racingteam
Group=racingteam
WorkingDirectory=/opt/racing-team/app
EnvironmentFile=/etc/racing-team.env
ExecStart=/usr/local/bin/node /opt/racing-team/app/node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/racing-team /opt/racing-team/app/.next

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now racing-team
sudo systemctl status racing-team --no-pager
curl -sI http://127.0.0.1:3000/login | head -3
```

Se il servizio non parte: `sudo journalctl -u racing-team -e`. Le righe di *hardening* (`ProtectSystem`, `ReadWritePaths`…) non sono state provate: se bloccano qualcosa, togline una alla volta.

### H. HTTPS con Caddy

`/etc/caddy/Caddyfile` (sostituisci il nome):

```
team.tuodominio.it {
	# Il tempo reale (SSE) non va compresso né messo in buffer.
	@compressible not path /api/realtime*
	encode @compressible zstd gzip

	# Le chat accettano fino a 120 MB per richiesta (limite applicato anche dall'app).
	request_body {
		max_size 130MB
	}

	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}

	header -Server
}
```

```bash
sudo systemctl reload caddy
curl -sI https://team.tuodominio.it/login | head -12
```

Caddy ottiene e rinnova da solo il certificato (servono le porte 80 e 443 aperte e il DNS già corretto). L'app aggiunge da sé HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` e un CSP parziale (vedi §3).

### I. Verifiche dopo l'avvio (tutte da fare)

```bash
U=https://team.tuodominio.it
curl -sI $U/login | grep -iE "^(HTTP|strict-transport|x-frame|x-content|content-security|set-cookie)"
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" $U/admin          # 307 verso /login
curl -s -o /dev/null -w "%{http_code}\n" $U/api/realtime                       # 401 senza sessione
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Origin: https://evil.example" -H "Content-Type: application/json" -d '{}' $U/api/chat   # 403
```

Poi nel browser: accedi come amministratore, apri `/admin`, crea un **membro di prova**, accedi con lui in una finestra privata e controlla che `/admin` lo rimandi a `/app`. Apri la **chat in due finestre** e verifica che un messaggio compaia subito nell'altra (è la prova che Caddy non mette il tempo reale in buffer). Registra e riascolta una **nota vocale** dal telefono (richiede HTTPS e il permesso del microfono).

### J. Creare gli account dei membri

`/admin/members` → **Aggiungi membro**: scegli una password provvisoria, comunicala fuori dall'app e chiedi di cambiarla da **Profilo**. Oggi non esiste né il cambio obbligato al primo accesso né il recupero via email (vedi §3). Dal server, con un piccolo comando che carica l'ambiente giusto:

```bash
sudo tee /usr/local/bin/racing-team-admin >/dev/null <<'EOF'
#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
set -a; . /etc/racing-team.env; set +a
cd /opt/racing-team/app
exec npm run -s admin:create -- "$@"
EOF
sudo chmod 755 /usr/local/bin/racing-team-admin

sudo -u racingteam racing-team-admin --reset-password --email membro@email.it     # nuova password (chiude le sessioni)
sudo -u racingteam racing-team-admin --suspend --email membro@email.it            # chi esce dal team: niente più accesso, storico conservato
sudo -u racingteam racing-team-admin --reactivate --email membro@email.it
sudo -u racingteam racing-team-admin --name "Altro Admin" --email altro@email.it --add   # un secondo Super Admin
```

Consiglio: tieni **almeno due Super Admin**. Lo script rifiuta di sospendere l'ultimo.

### K. Backup (obbligatorio, non opzionale)

`npm run db:backup` crea una copia **consistente** del database anche mentre l'app lavora, la controlla (`integrity_check`) e ruota quelle più vecchie di 14 giorni. Va portata **fuori dalla VM**, insieme ai file caricati.

```bash
gcloud storage buckets create gs://NOME-UNIVOCO-BACKUP --location=europe-west8 --uniform-bucket-level-access
gcloud storage buckets update gs://NOME-UNIVOCO-BACKUP --versioning
# Il servizio della VM deve poter scrivere SOLO in questo bucket:
SA=$(gcloud compute instances describe racing-team --zone=$ZONE --format='value(serviceAccounts[0].email)')
gcloud storage buckets add-iam-policy-binding gs://NOME-UNIVOCO-BACKUP --member=serviceAccount:$SA --role=roles/storage.objectAdmin
```

Sulla VM (se `gcloud` non c'è, installa `google-cloud-cli`):

```bash
sudo tee /usr/local/bin/racing-team-backup >/dev/null <<'EOF'
#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
set -a; . /etc/racing-team.env; set +a
cd /opt/racing-team/app
BACKUP_DIR=/var/backups/racing-team npm run -s db:backup
gcloud storage rsync --recursive /var/backups/racing-team gs://NOME-UNIVOCO-BACKUP/db
gcloud storage rsync --recursive "$STORAGE_DIR" gs://NOME-UNIVOCO-BACKUP/storage
EOF
sudo chmod 755 /usr/local/bin/racing-team-backup
echo '17 3 * * * racingteam /usr/local/bin/racing-team-backup >> /var/backups/racing-team/backup.log 2>&1' | sudo tee /etc/cron.d/racing-team-backup
sudo -u racingteam /usr/local/bin/racing-team-backup        # prova subito
```

**Prova il ripristino prima di fidarti dei backup** (una volta, a freddo):

```bash
sudo systemctl stop racing-team
sudo -u racingteam cp /var/backups/racing-team/racing-AAAAMMGG-HHMMSS.db /var/lib/racing-team/racing.db
sudo rm -f /var/lib/racing-team/racing.db-wal /var/lib/racing-team/racing.db-shm
sudo systemctl start racing-team        # poi accedi e controlla che i dati ci siano
```

Il database e i file vengono copiati in momenti diversi: dopo un ripristino un allegato può mancare o esserne rimasto uno senza messaggio (il pulitore dei file orfani dell'app elimina quelli senza riferimenti).

### L. Monitoraggio

Console → **Monitoring → Uptime checks**: controllo HTTPS su `https://team.tuodominio.it/login` ogni minuto, con avviso via email. Aggiungi un avviso sull'uso del disco. I log dell'app: `sudo journalctl -u racing-team -f`; quelli di Caddy: `sudo journalctl -u caddy`. Il registro di audit dell'app (`/admin/audit`) traccia accessi falliti, cambi di password e azioni amministrative.

### M. Aggiornare l'app

```bash
sudo systemctl stop racing-team
sudo -u racingteam bash -c 'set -euo pipefail; set -a; . /etc/racing-team.env; set +a; cd /opt/racing-team/app
  npm run -s db:backup                      # SEMPRE prima: le migrazioni vanno solo avanti
  git pull --ff-only && npm ci && npm run build'
sudo systemctl start racing-team           # fermo per qualche minuto: scegli un orario tranquillo
```

Per tornare indietro dopo una migrazione non basta cambiare il codice: serve **anche** ripristinare il backup preso prima dell'aggiornamento.

## 3. Sicurezza: cosa c'è, cosa manca

**C'è (verificato con test o in locale):** autorizzazione lato server su ogni pagina, azione e API (la UI nascosta non conta); password con scrypt; sessioni con token casuale di cui nel database resta solo l'hash, cookie `HttpOnly`, `SameSite=Lax` e `Secure` in produzione; blocco dopo 5 accessi falliti in 5 minuti per email, persistente; registro di audit append-only; controllo dell'origine sulle API; file caricati validati per contenuto, fuori da `public/`, serviti solo dopo i controlli di accesso; app in ascolto solo su `127.0.0.1`; header `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (solo microfono), HSTS e `frame-ancestors 'none'`; `noindex` per i motori di ricerca.

**Manca o è debole (non nascondiamolo):**

- **Nessuna autenticazione a due fattori.** Per gli amministratori è il rischio principale: usa password lunghe uniche e un gestore di password.
- **Nessun recupero password via email** e nessun invio di email: il recupero passa dal server (`--reset-password`). Le password iniziali dei membri le sceglie l'amministratore e **non c'è il cambio obbligato** al primo accesso.
- **Nessuna schermata per sospendere un membro, cambiare ruolo o reimpostare una password**: oggi lo si fa da riga di comando (sospendi, riattiva, reset). È la prima funzione da costruire dopo il lancio.
- **CSP parziale:** nessun `script-src` (richiederebbe nonce con gli script inline di Next): una falla XSS non verrebbe fermata dal CSP.
- Il blocco degli accessi per email permette a chi conosce un indirizzo di **bloccare** quell'account per 5 minuti (compromesso accettato: niente fiducia in header IP falsificabili).
- Nessuna scansione antivirus dei file caricati; limiti di frequenza solo su accesso, cambio password e caricamenti (nessun limite generale sulle altre API); nessun penetration test.
- **Istanza singola:** niente alta disponibilità; ogni aggiornamento ferma l'app per qualche minuto; se la VM si guasta si riparte dall'ultimo backup.
- Esportazione o cancellazione dei dati di un singolo utente (diritti GDPR) non sono funzioni dell'app: oggi richiedono un intervento manuale sul database.
- Nessun flusso di inviti, nessuna integrazione con l'ateneo (SSO), nessun push/email: vedi `docs/05-ecosystem.md` §9.

## 4. Lista di controllo prima di dare il link ai membri

- [ ] HTTPS valido sul dominio, HTTP che reindirizza a HTTPS
- [ ] Primo Super Admin creato, password nel gestore di password, **secondo** Super Admin creato
- [ ] Nessun utente dimostrativo nel database (`admin@racinghub.test` e simili non devono esistere)
- [ ] Verifiche del passo I eseguite; chat in tempo reale provata con due finestre; nota vocale provata dal telefono
- [ ] Backup notturno eseguito **almeno una volta con successo** e **ripristino provato**
- [ ] Avviso di budget, controllo di uptime e avviso sul disco attivi
- [ ] Informativa privacy pronta e titolare del trattamento deciso
- [ ] SSH solo tramite IAP; aggiornamenti automatici di sicurezza del sistema operativo attivi
