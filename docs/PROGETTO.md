# Finanze personali — progetto

App personale, privata e gratuita, per iPhone. PWA offline-first, nessun backend, nessun account, nessuna analisi.
Stato: **v0.1 (prima versione utilizzabile, dati dimostrativi)**.

## 1. Architettura tecnica

| Scelta | Motivo |
|---|---|
| **JavaScript vanilla, moduli ES, zero dipendenze, nessun build** | Per un'app di finanze ogni libreria è superficie d'attacco e di manutenzione. Il codice caricato è solo quello di questo repository: si può rileggere intero. |
| **PWA + Service Worker** (cache dell'app shell) | Installabile da Safari ("Aggiungi alla schermata Home"), funziona offline. Il SW non vede mai dati finanziari. |
| **IndexedDB** (solo blob cifrati) | Persistenza locale. Nessun dato finanziario in chiaro, nessun `localStorage`/cookie. |
| **Web Crypto API** | AES-256-GCM + PBKDF2-SHA256: algoritmi standard, implementati dal browser, non da codice nostro. |
| **CSP rigorosa** (`default-src 'none'`, `connect-src 'none'`) | Il browser stesso impedisce all'app di contattare qualunque server, anche in caso di bug o XSS. |
| **Importi in centesimi interi** | Nessun float nei calcoli. `mulBp` usa BigInt per le percentuali. |

### Struttura

```
index.html · manifest.webmanifest · sw.js · _headers (CSP come header HTTP)
src/core/      logica contabile PURA, senza DOM né I/O (testata da sola)
  money · dates · canonical · errors
  state · validate      forma dei dati + invarianti duri
  derive                saldi, fondi, libero (sempre derivati, mai memorizzati)
  commands              UNICO punto di mutazione (clone → regole → validazione → audit)
  audit                 storico a catena di hash
  budget · allocation · forecast · integrity · demo
src/crypto/    vault (chiavi, cifratura) · backup (.fpbak) · hash · b64
src/storage/   adapter IndexedDB e in-memoria (test)
src/app/       interfaccia: html (escaping automatico) · views · actions · main
tests/         169 test automatici (node:test)
scripts/       serve · e2e (Chromium reale) · check-sw · make-icons
```

Flusso di ogni modifica: `azione utente → comando (su COPIA dello stato) → regole contabili → validateState → voci di audit → cifratura → scrittura IndexedDB → solo allora lo stato in memoria cambia → render`. Se un passaggio fallisce, **non cambia nulla** (test: "atomicità").

## 2. Modello dati e regole di quadratura

Tutti gli importi sono interi in centesimi; le date sono stringhe `YYYY-MM-DD`.

| Collezione | Contenuto | Note |
|---|---|---|
| `accounts` | conti, saldo iniziale, data | il saldo iniziale non viene mai modificato |
| `transactions` | entrate, uscite, rettifiche (importo con segno) | **uniche** fonti dei saldi insieme ai trasferimenti |
| `transfers` | trasferimenti tra conti | collezione **separata**: non sono mai entrate/uscite |
| `funds` | fondi virtuali legati a un conto (obiettivo, fiscale, acquisto, riserva) | vincoli contabili, non denaro |
| `allocations` | assegnazioni/rilasci/spostamenti verso i fondi | solo aggiunte (append-only): si corregge con un'allocazione opposta |
| `receivables` | incassi professionali attesi → ricevuti/annullati | attesi = previsione, mai nei saldi |
| `planned` | acquisti e spese straordinarie (anche ricorrenti) | alimentano le previsioni |
| `reconciliations` | saldo dichiarato dalla banca a una data | confronto con quanto derivato |
| `audit` | storico modifiche a catena di hash | ogni voce contiene prima/dopo |

### Formule (tutte derivate, `src/core/derive.js`)

```
saldo(conto)      = saldo iniziale + Σ movimenti validi + Σ trasferimenti in − Σ trasferimenti out
fondo.assegnato   = Σ allocazioni del fondo
fondo.speso       = Σ uscite collegate al fondo
fondo.disponibile = assegnato − speso                      (mai < 0: invariante dura)
libero(conto)     = saldo(conto) − Σ disponibile dei fondi di quel conto
```

Un importo è o *libero* o *in un solo fondo*, per costruzione: il libero è una differenza, quindi lo stesso euro non può essere assegnato due volte.

### Regole → dove sono garantite → dove sono testate

| Regola | Garanzia | Test |
|---|---|---|
| I trasferimenti non sono entrate/spese | collezione separata, nessun `income/expense` generato | `accounting-rules`: "i trasferimenti non sono…", `property` |
| Un importo non in due fondi | libero per differenza; `assignToFund` rifiuta oltre il libero | "un importo non può essere assegnato a due fondi" |
| Saldi derivano da movimenti effettivi | nessun campo "saldo" memorizzato; date future rifiutate | "i saldi derivano solo dai movimenti" |
| Previsioni separate dai saldi | `forecast` calcola al volo, non scrive nulla; incassi attesi solo nello scenario informativo | `planning`: "previsione: gli incassi non ricevuti NON sono mai disponibili" |
| Accantonamento ≠ trasferimento bancario | allocazione virtuale vs record in `transfers`; la UI li etichetta diversamente | "regola fiscale: … virtuale, distinguibile…", "le allocazioni sono virtuali" |
| Correzioni tracciabili | annullamento con motivo obbligatorio, niente cancellazioni; audit con prima/dopo | "le correzioni sono tracciabili", "regressione: lo storico non cambia retroattivamente" |
| Centesimi interi | `isCents` ovunque; `parseEuro` rifiuta >2 decimali | `money-dates`, `integrity` (float iniettato) |
| Storico non manomissibile in mezzo | hash(prev ‖ voce) | `integrity-audit`: modifica/rimozione/riordino rilevati |
| Quadratura con la banca | saldo dichiarato vs derivato alla data; rettifica esplicita | "quadratura con la banca…" |

**Controlli di quadratura** (Impostazioni → Controlli): struttura e riferimenti, trasferimenti a somma zero, conservazione del saldo totale, ricalcolo indipendente dei saldi, fondi mai negativi, vincoli entro il saldo di ogni conto, spostamenti a somma zero, incassi↔movimenti univoci, quadrature bancarie, catena di hash.

Politica deliberata: le operazioni *virtuali* (assegnare, spostare, spendere da fondo) vengono **bloccate** se violano le regole; la registrazione di un fatto *reale* (una spesa fatta) **non viene mai bloccata** dai vincoli virtuali: se fa scendere il libero sotto zero, l'app lo segnala come problema di liquidità.

### Suggerimenti di allocazione

Funzione pura e deterministica. Ordine: 1) regole fiscali (percentuale dell'incasso, arrotondamento half-away-from-zero), 2) fabbisogni con scadenza entro N giorni (per scadenza, poi priorità), 3) il resto per priorità poi scadenza. Mai oltre il fabbisogno del fondo né oltre il libero del conto; il resto rimane libero. L'utente può modificare gli importi prima di applicare; l'applicazione è atomica.

### Previsioni di liquidità

Orizzonte configurabile (90 gg). Serie **prudente**: parte dal saldo reale e sottrae budget settimanale (considerato impegnato a inizio settimana) e acquisti programmati (sul *libero* pesa solo la parte non coperta dal fondo dedicato). Gli incassi attesi **non** entrano; compaiono solo in una serie opzionale "con incassi attesi", al netto degli accantonamenti fiscali. Incassi in ritardo non contano e vengono segnalati. Problemi rilevati: libero previsto negativo (con data), saldo totale negativo, vincoli oltre il saldo di un singolo conto, obiettivi a rischio, incassi in ritardo.

### Regole confermate dall'utente (v0.3: correzioni della v0.2)

| # | Regola | Come è implementata | Test |
|---|---|---|---|
| 1 | Riserva fiscale **personalizzata per cliente** (es. 300 € su una fattura da 1.200 €), distinta dalla stima teorica; il resto è disponibilità personale. | `reserveCents` su fattura ricorrente e su incasso atteso. Alla ricezione la proposta contiene **una sola voce** (la riserva): nessun altro fondo viene proposto in automatico. Se manca la regola si usa la stima teorica arrotondata. La riserva è **fissa** di default; per un incasso **parziale** è proporzionale a quanto ricevuto, con traccia di previsto/accantonato/residuo; se l'importo **definitivo** cambia l'app lo segnala e lascia scegliere (fissa · proporzionale · stima fiscale) senza mai modificare le regole future. | `incassi-parziali`, `regole-utente` §1 |
| 2 | L'incasso si registra sul conto effettivo (Isybank). L'accantonamento nasce **virtuale**; il bonifico verso Trade Republic si **conferma** dopo. Nessun trasferimento registrato da una semplice proposta. | Ogni allocazione ha un `accountId`: pesa sul libero del conto dove sono i soldi. `applyAllocationPlan` non crea mai trasferimenti. "Bonifici da confermare" (Panoramica e dettaglio fondo) → `confirmFundTransfer`: crea il trasferimento reale (anche parziale, con data) e sposta la riserva sul conto di destinazione. | `regole-utente` §2 |
| 3 | Il PAC è un **investimento**: incide sulla liquidità e sul "versato", ma non sulle spese. | Tipo di movimento `investment` (categoria "Investimenti (PAC)"). Fuori da grafici delle spese e dal budget; mostrato come "Investito" (versamenti cumulati, **non** valore di mercato). Nelle previsioni è un'uscita. Migrazione dei vecchi PAC registrati come spese. | `regole-utente` §3 |
| 4 | Stima fiscale per fattura ≠ debito annuale; contributi deducibili trattati correttamente. | `estimateTaxes` (una fattura): nessuna deduzione. `estimateAnnual` (anno, **per cassa**): imponibile = ricavi × coefficiente; contributi = imponibile × INPS; imposta = (imponibile − **contributi INPS effettivamente versati nell'anno**) × aliquota. Scenari: nessun versamento / tutti versati. Pagina Tasse: dovuto, versato, ancora da versare, riserva accantonata, margine. | `regole-utente` §4 |
| 6 | Calendario: niente duplicati, scadenze aggiornabili. | UID stabili, `SEQUENCE` crescente, `DTSTAMP` all'esportazione, `STATUS:CANCELLED` per voci pagate/annullate/disattivate; procedura con calendario dedicato "Finanze" da eliminare e reimportare. | `regole-utente` §6 + parser indipendente |

**Correzione di un errore della v0.2**: la v0.2 registrava come *eseguito* il trasferimento verso Trade Republic appena si applicava una proposta, e sottraeva i contributi della singola fattura dal suo imponibile. Entrambi sono stati rimossi.

**Grafici**: "Riserva fiscale" è quanto accantonato **davvero** (le allocazioni nel fondo fiscale), non la stima teorica; il "Disponibile" è incassi − riserva − spese. Trasferimenti, investimenti e pagamenti di imposte/contributi non compaiono tra le spese.

### Profilo, incassi parziali e stato dei dati (v0.4)

* **Profilo personale iniziale** (file separato, mai nel repository, vedi [PROFILO.md](PROFILO.md)): conti con ruolo, fondi e obiettivi, regole di fatturazione, scadenze, profilo fiscale. Non registra movimenti, non finanzia fondi, non segna nulla come pagato e **non inventa saldi**: i conti restano **"Da aggiornare"** (non zero) finché non imposti il saldo; con saldi mancanti previsioni e allarmi di liquidità sono dichiarati *parziali* invece di segnalare scoperti falsi.
* **Tre livelli distinti** nella pagina *Stato dei dati*: **dati configurati** (impostazioni) · **movimenti previsti** (pianificazione, non denaro) · **movimenti effettivi da confermare** (saldi da impostare, bonifici da confermare, scadenze e incassi in arrivo, voci "da confermare come attiva" o con "data da confermare").
* **Incassi parziali e importo definitivo**: vedi la tabella delle regole (punto 1). Un incasso può avere più rate; stato *previsto → parziale → incassato*.
* **Fondi gerarchici**: un sotto-fondo (es. abbigliamento del viaggio) è incluso nel budget del fondo madre e viene tolto dal suo fabbisogno: nessun doppio conteggio. Stessa idea per le **sottocategorie** di spesa (la sottocategoria conta dentro la madre).
* **Obiettivi** "da definire" (nessun importo inventato), con intervallo minimo–massimo e flag *provvisorio*.
* **Fisco: quattro numeri separati** (pagina Tasse): *stima fiscale* · *accantonamento personale (virtuale)* · *somme effettivamente trasferite (bonifici confermati)* · *debiti effettivamente pagati*. Aliquote iniziali marcate **"da verificare per l'anno"** finché non le confermi.
* **Categorie**: spese di consumo, **investimenti** (separati) e entrate; risparmio e trasferimenti non sono mai spese.

### Saldi e tasche (v0.5)

* **Aggiornare i saldi in qualsiasi momento**, anche in blocco (Panoramica → *Aggiorna saldi*): scrivi il saldo reale di oggi dei conti che vuoi (gli altri vuoti). Non si riscrive mai la storia: un conto **senza movimenti** corregge semplicemente il saldo iniziale (un errore di battitura non lascia rettifiche); un conto **con movimenti** registra una **rettifica tracciata** di oggi (categoria *Rettifica di quadratura*, mai una spesa né un'entrata) con la differenza. Operazione atomica.
* **Tasche** (sotto-conti della stessa banca, raggruppati nella mappa dei soldi): ad esempio Trade Republic = *Tasse* (liquidità, dove arrivano i bonifici) + *PAC* (investito). Un conto di tipo **investimento** fa parte del patrimonio ma **non della liquidità**: il "libero da spendere", le previsioni e le riserve dei fondi non lo contano.
* **Versamento PAC = trasferimento interno** (scopo *investimento*) dalla tasca Tasse alla tasca PAC, il giorno di scadenza (es. il 2): non è una spesa né un'entrata, riduce la liquidità, aumenta l'*investito* e non tocca grafici delle spese né budget.
* **Esecuzione automatica opzionale** (per voce): all'apertura dell'app i versamenti scaduti vengono eseguiti da soli, con la data di scadenza e traccia "automatico" nello storico. Si ferma se nella tasca di origine non c'è denaro **libero** sufficiente (la riserva fiscale non viene mai consumata) e le voci "da confermare" non partono. Disattivabile per ogni voce.

### Altre funzioni per l'autonomo (v0.2)

* Fatture ricorrenti (giorno di fatturazione + giorni d'incasso) → incassi **attesi** generati ogni mese; "Incassata ✓" li trasforma in movimenti con l'importo effettivo.
* Spese ricorrenti, rinnovi e PAC con cadenza (settimanale, mensile, trimestrale, annuale), addebito automatico, promemoria, "Pagato ✓".
* Reintegro: se la riserva di un conto supera il suo saldo (es. prelievo dal conto tasse) compare l'avviso con **Riequilibra** (prepara un bonifico da confermare).
* Obiettivi con quota mensile necessaria; "Dove sono i tuoi soldi" per conto; banche con colore e sigla, logo dalla galleria, icone e colori.
* Avvisi: una PWA non può inviare notifiche in background senza un server; per restare privati l'app esporta un `.ics` che il Calendario di iOS notifica da sola.

## 3. Sicurezza → vedi [SICUREZZA.md](SICUREZZA.md)

## 4. Backup e recupero

* **Dove stanno i dati**: solo su questo iPhone, cifrati. Safari/iOS può cancellare i dati di un sito (pulizia dati, spazio, reinstallazione): **il backup è l'unica vera protezione**.
* **File `.fpbak`**: JSON con header autenticato (formato, versione, data, parametri KDF) + contenuto AES-256-GCM. Chiave derivata da una **password scelta al momento del backup** (può differire da quella dell'app), con salt proprio. Il file non contiene testo in chiaro (test).
* **Verifica immediata**: dopo la creazione l'app **ricostruisce e decifra il file appena creato** e controlla hash, schema, riepilogo e quadratura; solo se tutto torna offre il salvataggio. Il file va in *File / iCloud Drive* tramite il foglio di condivisione (o download).
* **Verifica senza ripristino**: Impostazioni → Backup → *Verifica un backup*.
* **Ripristino verificabile**: decifratura (tag GCM) → hash del contenuto → validazione schema/riferimenti → controlli di quadratura → riepilogo a confronto con i dati attuali → conferma scritta "RIPRISTINA" → copia di sicurezza interna cifrata dei dati attuali (`pre-restore`) → sostituzione → voce di audit. Backup con errori di quadratura non si ripristinano su un archivio nuovo.
* **Nuovo telefono / dati persi**: schermata iniziale → *Ripristina da backup* → scegli file, password del backup, nuova password dell'app.
* **Promemoria**: avviso in Panoramica se l'ultimo backup ha più di N giorni (default 14).
* **Password dimenticata**: senza password non c'è recupero (è il punto della cifratura). Con un backup si riparte.

## 5. Piano di sviluppo per fasi

| Fase | Contenuto | Stato |
|---|---|---|
| 0 | Nucleo contabile, regole, test | ✅ |
| 1 | Cifratura locale, blocco, sessioni, backup/ripristino verificabile | ✅ |
| 2 | UI cinque sezioni, dati demo, previsioni, allocazioni, quadratura | ✅ (**v0.1**) |
| 3 | **Prova su iPhone reale** (Safari/WebKit, installazione, share sheet, tastiera, rotazione), rifinitura UX | ⏳ da fare da te: vedi README |
| 4 | Categorie personalizzate e ricerca; movimenti ricorrenti; import CSV dalla banca (con anteprima e dedup) | proposta |
| 5 | Sblocco con Face ID via WebAuthn PRF (solo se supportato in modo affidabile da iOS); aggiornamenti con conferma esplicita e impronta della versione | proposta |
| 6 | Revisione di sicurezza indipendente prima di caricare dati reali importanti | consigliata |

### Decisioni aperte (da confermare)

1. **Hosting** (serve HTTPS per Service Worker e Web Crypto): GitHub Pages è gratuito solo per repository *pubblici* (il codice non contiene dati personali: i dati demo sono fittizi); in alternativa Cloudflare Pages o Netlify, gratuiti anche per repo privati. Nessun servizio è stato attivato.
2. **KDF**: PBKDF2 (disponibile nativamente) vs Argon2id (più resistente, ma richiede una libreria WASM esterna: aggiunge dipendenza). Scelto PBKDF2 con 600.000 iterazioni e password lunga obbligatoria.
