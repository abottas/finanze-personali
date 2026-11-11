# Sicurezza: modello, test eseguiti, rischi residui

> **L'app non è dichiarata "sicura".** Questo documento dice cosa è stato progettato, cosa è stato *effettivamente verificato*, e cosa no. Non è un audit indipendente. Prima di inserire dati reali importanti vedi la sezione "Prima dei dati reali".

## Cosa si vuole proteggere, da chi

| Scenario | Protezione |
|---|---|
| Telefono perso/rubato **bloccato** | Protezione di iOS + cifratura dei dati dell'app (AES-256-GCM): senza la password, IndexedDB contiene solo blob cifrati. |
| Telefono sbloccato in mano ad altri | Blocco automatico (default 2 min di inattività, 30 s in background), copertura dello schermo nel selettore app, modalità "nascondi importi". |
| Estrazione dei file del browser (backup del telefono, forense) | Cifratura a riposo; resistenza = forza della password × costo di PBKDF2. |
| Sito/pagina malevola o XSS | CSP senza `unsafe-inline`/`eval`, `connect-src 'none'`, escaping automatico di ogni testo utente, nessuna libreria terza. |
| Invio dati a terzi | Impossibile da CSP (nessuna connessione consentita) + nessun codice di rete (test statici). |
| Perdita dei dati | Backup cifrati verificabili, snapshot pre-ripristino, due slot di salvataggio alternati. |

**Fuori scopo:** malware/jailbreak sul telefono, keylogger, attaccante che controlla il server da cui l'app viene servita (vedi rischi).

## Progetto crittografico

```
password ─ NFKC ─▶ PBKDF2-HMAC-SHA256, 600.000 iter, salt 16 B casuale ─▶ KEK  (AES-GCM, NON estraibile)
DEK = 256 bit casuali (crypto.subtle.generateKey) ──wrapKey(AES-GCM, AAD = FP1|wrap|parametri KDF)──▶ IndexedDB
stato ──AES-256-GCM(DEK, IV 96 bit casuale a ogni salvataggio, AAD = FP1|data|<revisione>)──▶ 2 slot alternati
```

* La **password non viene mai salvata** (né in localStorage né altrove). Il controllo password è lo *unwrap* della DEK: una password errata fa fallire l'autenticazione GCM.
* In sessione la DEK è un `CryptoKey` **non estraibile**: lo script non può leggerne i byte (test `dekExtractable === false`).
* Cambiare password = ri-cifrare solo la DEK con una nuova KEK (nuovo salt); i dati non si toccano.
* Migrazione automatica: se i parametri salvati hanno meno iterazioni di quelle attuali, la DEK viene ri-incapsulata allo sblocco.
* L'**AAD** lega ogni blob al proprio ruolo e alla revisione: non si scambiano slot, non si abbassano le iterazioni nell'header senza far fallire l'autenticazione.
* Il **backup** usa una chiave indipendente (password e salt propri) e autentica l'intero header come AAD.
* Tentativi errati ripetuti introducono un ritardo crescente (*solo cosmetico*: chi ha i file può aggirarlo; la vera difesa è il costo di PBKDF2 e la lunghezza della password).
* Password minima 12 caratteri; rifiutate quelle ripetitive o solo numeriche.

## Verifiche eseguite (automatiche, riproducibili: `npm test`, `node scripts/e2e.mjs`)

**Cifratura (`tests/crypto.test.js`)**: round-trip; nessun nome/importo/chiave/password in chiaro nello storage, né in base64; password errata rifiutata; chiave non estraibile; `lock()` impedisce di salvare; IV diverso a ogni salvataggio (20/20); ciphertext manomesso → rilevato e recupero dallo slot precedente integro; tutti gli slot corrotti → errore esplicito, mai dati parziali; scambio di slot/revisioni (replay) rifiutato; downgrade delle iterazioni nell'header rifiutato; cambio password; ritardo sui tentativi; migrazione KDF; snapshot cifrato.
**Backup**: round-trip con verifica di hash/schema/quadratura; nessun testo in chiaro; password errata indistinguibile dalla manomissione; bit alterato in `ct`, `iv`, header (data, iterazioni) → rifiutato; file troncato/non valido/versione sconosciuta/iterazioni abusive → errori puliti; stato incoerente non esportabile.
**Codice (`tests/static-guards.test.js`)**: nessun `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon`; nessun URL esterno nei sorgenti; nessun `localStorage`/`sessionStorage`/cookie/`eval`/`new Function`; nessun handler/stile inline; CSP con `connect-src 'none'` e senza `unsafe-*`; ogni `innerHTML` passa dall'escaping; cache offline coerente con i file usati.
**Browser reale (Chromium, `scripts/e2e.mjs`)**: 0 violazioni CSP, 0 richieste verso l'esterno, 0 errori in console; HTML inserito dall'utente mostrato come testo; IndexedDB senza dati in chiaro; nessun dato in localStorage/sessionStorage/cookie; dopo il blocco nessun dato resta nel DOM; avvio **offline** dopo la prima visita; backup → ripristino su archivio nuovo; password di backup errata rifiutata.
**Contabilità**: 149 test totali incl. 4 sequenze casuali da 150 operazioni con invarianti verificati a ogni passo.

## Cancellazione dei dati del browser (verificato in Chromium)

| Scenario | Comportamento verificato |
|---|---|
| Cancellazione **totale** (come "Cancella dati siti") | L'app riparte dalla schermata di benvenuto, senza errori. Si ricostruisce da un backup (file + password del backup + nuova password). |
| Spariscono i **dati** ma restano le chiavi | La password è accettata ma l'app dice "dati danneggiati, ripristina da backup": nessun dato inventato, nessuna schermata vuota ingannevole; il ripristino funziona dalla stessa schermata. |
| Spariscono le **chiavi** ma restano dati orfani | Si può creare un nuovo archivio: i dati orfani (illeggibili) vengono rimossi alla creazione (test: nello storage resta solo lo slot nuovo). |
| Ripristino da backup dopo la cancellazione | Verificato end-to-end. |
| **Non verificabile qui**: quando e se iOS cancella i dati di un sito | L'app chiede l'archiviazione persistente e mostra in Impostazioni → Backup se è stata concessa, ma **non è una garanzia**: va fatto il backup. |

## Stato delle verifiche: eseguite vs ancora necessarie

| Area | Eseguito (riproducibile) | Ancora necessario |
|---|---|---|
| Cifratura archivio | AES-256-GCM + PBKDF2 600k; nessun testo in chiaro nello storage (nemmeno base64); chiave di sessione non estraibile; manomissione di dati/header/slot rilevata; recupero dallo slot precedente | Test su Safari/iPhone reale; audit esterno |
| Password | Mai salvata; nessuna traccia in storage/DOM dopo lo sblocco; errata rifiutata; ritardo ai tentativi (cosmetico); cambio password; minimo 12 caratteri | Scelta di una frase lunga da parte tua (il limite vero è la forza della password) |
| Blocco | Copertura schermo in background; blocco dopo X secondi in background (verificato); **blocco per inattività con timer reale** (verificato) | Comportamento del ciclo di vita di iOS (app sospesa/riattivata) |
| Backup | Round-trip, verifica immediata del file creato, password errata, bit alterati in ciphertext/IV/header, file troncato/non valido; nessun testo in chiaro | Provare il salvataggio in File/iCloud Drive dal foglio di condivisione di iOS |
| Ripristino | Su archivio nuovo e esistente, con quadratura e conferma scritta, snapshot interno; dopo cancellazione totale/parziale | Ripristino reale su un secondo dispositivo |
| Cancellazione dati browser | Vedi tabella sopra (Chromium) | Eviction reale di iOS |
| Rete/privacy | CSP `connect-src 'none'`; 0 richieste esterne e 0 violazioni in browser; cache del Service Worker solo file dell'app | — |
| Calendario | UID stabili, SEQUENCE crescente, annullamenti; file accettato da un parser iCalendar indipendente | **Reimportazione reale su iPhone** (duplicati / aggiornamenti) |
| Hosting | — | Distribuzione privata su Cloudflare Pages e prova di installazione |

## NON verificato (da non dare per scontato)

* **Safari/WebKit su iPhone reale**: provato solo con Chromium. Comportamenti specifici di iOS (installazione, Web Share di file `.fpbak`, tastiera, selettori data, eviction dei dati, ciclo di vita in background) vanno provati sul dispositivo.
* **Audit indipendente / penetration test**: non eseguiti.
* **Prestazioni di PBKDF2 su iPhone**: 600k iterazioni sono tipicamente sotto il secondo, ma non misurato qui.
* **Volumi elevati** (decine di migliaia di movimenti): non testati; l'intero stato viene ricifrato a ogni modifica.

## Rischi residui

1. **Fiducia nel server di hosting.** Il codice arriva da dove lo pubblichi: chi lo controlla potrebbe servire una versione modificata (anche con CSP diversa) che ruba la password. Mitigazioni: account di hosting/GitHub con 2FA, pubblicare solo commit riletti, il SW non si aggiorna a metà sessione. *Miglioramento previsto:* mostrare l'impronta della versione e richiedere conferma all'aggiornamento.
2. **PBKDF2 non è memory-hard.** Un attaccante con i file e GPU può provare molte password: la sicurezza dipende dalla **lunghezza** della password (usa una frase di 5+ parole). Argon2id richiederebbe una libreria WASM esterna.
3. **Dati in memoria da sbloccati.** Lo stato in chiaro vive nella memoria JS mentre l'app è sbloccata; JavaScript non permette di azzerarla con certezza. Il blocco rimuove i riferimenti, non garantisce la cancellazione fisica.
4. **Rollback.** Chi può scrivere nello storage del browser può rimettere uno slot più vecchio (valido): non rilevabile in locale. Idem il troncamento in coda dello storico (la catena rileva solo manomissioni *in mezzo*).
5. **Eviction/cancellazione dei dati da parte di iOS** → perdita: solo i backup proteggono.
6. **Password di backup debole** → backup attaccabile offline. Il file è solo cifrato con PBKDF2: stessi limiti del punto 2.
7. **Esportazione CSV in chiaro** (opzionale, con avviso): chi riceve il file vede tutto.
8. **Autofill/Password di iOS**: i campi consentono il gestore password di iOS; la password può quindi vivere nel portachiavi del sistema (scelta dell'utente, fuori dall'app).
9. **Screenshot/registrazione schermo** non rilevabili da una PWA.
10. **Calendario (.ics)**: il file contiene i nomi delle scadenze (e gli importi solo se scegli di includerli). Una volta nel Calendario di iOS, se sincronizzato con iCloud, quei titoli escono dall'app: è una tua scelta esplicita e non cifrata dall'app.
11. **Il profilo personale è un file in chiaro** (JSON con nomi di clienti e importi) finché non lo importi: tienilo solo sul tuo telefono, non condividerlo e cancellalo dopo l'importazione. Non è nel repository.
12. **Loghi**: la CSP consente `img-src data:` solo per mostrare i loghi; lo schema accetta esclusivamente PNG in base64 di dimensione limitata (test: un `data:text/html` o `javascript:` viene rifiutato).

## Prima dei dati reali

1. Prova l'app su iPhone con i dati demo (installazione, blocco, backup→ripristino su un secondo browser).
2. Scegli una frase-password lunga, mai usata altrove.
3. Fai un backup e **ripristinalo davvero** (verifica) prima di fidarti.
4. Pubblica da un account con 2FA; valuta una revisione esterna se i dati sono sensibili.
