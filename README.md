# Finanze personali

App personale per gestire le proprie finanze **solo da iPhone**: privata, gratuita, offline, cifrata.
Nessun backend, nessun account, nessuna analisi, nessuna connessione verso l'esterno (imposto dalla CSP del browser).

* **Progetto, modello dati, backup, fasi:** [docs/PROGETTO.md](docs/PROGETTO.md)
* **Profilo personale iniziale (file separato, non nel repository):** [docs/PROFILO.md](docs/PROFILO.md)
* **Sicurezza, test eseguiti, rischi residui:** [docs/SICUREZZA.md](docs/SICUREZZA.md)

> Stato: v0.1, con dati dimostrativi fittizi. Non ancora provata su un iPhone reale e non sottoposta ad audit indipendente: **non usare dati reali importanti prima di aver letto la sezione "Prima dei dati reali" in SICUREZZA.md.**

## Le cinque sezioni

Panoramica (saldo, libero, vincolato, budget, fondi, scadenze, problemi) · Movimenti (entrate, uscite, trasferimenti) · Fondi (obiettivi, accantonamenti, riserve) · Incassi (attesi ed effettivi) · Pianificazione (previsioni di liquidità, acquisti programmati, suggerimenti di allocazione). Impostazioni: conti, budget e regole fiscali, quadratura, storico, sicurezza, backup.

## Provarla in locale

Serve solo Node ≥ 22 (nessuna dipendenza da installare).

```bash
npm test                    # 183 test: regole contabili, cifratura, backup, controlli statici
node scripts/serve.mjs      # http://127.0.0.1:8080/  (localhost è un "contesto sicuro")
node scripts/e2e.mjs        # prova end-to-end in Chromium (richiede Playwright)
```

## Installarla sull'iPhone

L'app è una cartella di file statici e richiede un indirizzo **HTTPS**. Il codice **non contiene dati personali**: i tuoi dati stanno solo nell'archivio cifrato del telefono e il tuo profilo iniziale è un file separato (vedi [docs/PROFILO.md](docs/PROFILO.md)).

### GitHub Pages (gratuito, richiede un repository pubblico)

Da Safari sull'iPhone, su `github.com/<tuo-utente>/finanze-personali`:

1. **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**.
2. **Branch**: scegli il branch di pubblicazione e la cartella **`/ (root)`** → **Save**.
3. Attendi 1–2 minuti e ricarica la pagina: compare "Your site is live at `https://<tuo-utente>.github.io/finanze-personali/`".
4. Il file `.nojekyll` (già presente) evita che GitHub rielabori i file con Jekyll.

GitHub Pages non applica il file `_headers`: resta attiva la CSP dichiarata nel `<meta>` di `index.html` (blocca ogni connessione di rete). Per avere la CSP anche come header HTTP e il repository privato si può usare Cloudflare Pages (gratuito).

### Installazione sulla schermata Home
1. Apri l'indirizzo in **Safari** (non in Chrome: solo Safari permette l'installazione).
2. Condividi → **Aggiungi alla schermata Home** → apri l'app dall'icona.
3. Primo accesso: scegli una **password lunga** (almeno 12 caratteri, meglio una frase) e l'avvio: *Dati demo*, *Mio profilo* (file) o *Vuoto*.

### Prova guidata (15 minuti) prima dei dati reali
1. Crea l'archivio con i **dati demo**; chiudi l'app dallo switcher e riaprila: deve chiedere la password.
2. Impostazioni → Backup → *Crea backup cifrato* → salva in **File / iCloud Drive**. Poi *Verifica un backup* scegliendo quel file.
3. Metti l'iPhone in **modalità aereo** e riapri l'app: deve funzionare.
4. Impostazioni → Sicurezza → blocco dopo 30 secondi: lascia l'app ferma e controlla che si blocchi; passa a un'altra app e torna.
5. *Cancella tutto* → riapri → *Ripristina da backup* con il file salvato: i dati devono tornare identici.
6. Calendario: Impostazioni → Calendario e avvisi → esporta; importa **in un calendario nuovo "Finanze"** con **una sola scadenza**. Modificala, riesporta e reimporta: controlla se si aggiorna o si duplica. Se duplica, elimina il calendario "Finanze" e reimporta (procedura sicura).
7. Solo dopo, **cancella i dati demo** e riparti dal **tuo profilo** (Impostazioni → Cancella tutto → Mio profilo) o inserisci i dati a mano.

## Aggiornare l'app

Pubblica i nuovi file e incrementa `VERSION` in `sw.js`. L'iPhone scarica la nuova versione in background e la attiva quando chiudi del tutto l'app (mai a metà sessione). `node scripts/check-sw.mjs` verifica che la cache offline sia completa.

## Licenza

Uso personale. Nessuna licenza concessa.

## Analisi, previsioni ed export (v0.7)

- **Analisi**: indicatori medi, entrate/uscite per mese (tocca un mese per il dettaglio), liquidità a fine mese, budget settimanale, categorie nel tempo, tabella mensile; periodo 3/6/12 mesi.
- **Pianificazione**: liquidità passata + prevista (prudente e con incassi attesi) e previsione mensile di entrate/uscite, incluse le fatture ricorrenti future (mai considerate garantite).
- **Esporta** (CSV, separatore `;`): statistiche mensili, previsione per mese, previsione dettaglio per movimento. I file **non sono cifrati**.
