# Profilo personale iniziale

L'app può partire **già configurata** (conti, ruoli, fondi, regole di fatturazione, scadenze ricorrenti, profilo fiscale)
importando un **file di profilo** al primo accesso. Il profilo è un file JSON **separato dal codice**:

* **non è nel repository** (`profilo-personale*.json` è in `.gitignore`): il codice pubblicato contiene solo il costruttore generico;
* viene letto **sul telefono**, applicato in un'unica operazione atomica e poi vive solo nell'archivio **cifrato** locale;
* dopo l'importazione puoi cancellare il file dal telefono.

Un esempio con dati inventati è in `tests/fixtures/profilo-esempio.json`.

## Cosa fa (e cosa non fa) l'importazione

| Fa | Non fa |
|---|---|
| Crea i conti con banca (colore e sigla), ruolo e tipo | **Non inventa saldi**: i conti senza `openingCents` restano **"Da aggiornare"** (non zero) |
| Crea fondi e obiettivi (anche "da definire", provvisori, con intervallo minimo–massimo, sotto-fondi) | **Non finanzia nessun fondo**: nessuna allocazione |
| Crea le regole di fatturazione (cliente, importo, giorno, giorni d'incasso, riserva fissa) e gli incassi **previsti** dei mesi successivi | Non registra fatture emesse né incassi: i previsti non sono denaro |
| Crea scadenze ricorrenti (abbonamenti, PAC come investimento, ecc.) | **Non le segna come pagate**; senza giorno noto restano "data da confermare", e "da confermare come attiva" non entra in previsioni né avvisi finché non le confermi |
| Attiva il profilo fiscale con le aliquote del file, marcate **"da verificare"** | Non registra nessun movimento, trasferimento o pagamento |

Si applica **solo a un archivio senza conti**. Dopo l'importazione ogni elemento si modifica dall'app (nome, ruolo, importi,
scadenze, regole) **senza perdere lo storico**: ogni modifica è tracciata con valore prima/dopo.

## Formato (`format: "FP-PROFILE"`, `v: 1`)

```jsonc
{
  "format": "FP-PROFILE", "v": 1,
  "accounts": [ { "key": "a", "name": "…", "bank": "isybank|revolut|trade_republic|bbva|buddybank|…", "role": "…", "openingCents": 12345 /* opzionale */ } ],
  "taxProfile": { "coefficientBp": 7800, "inpsBp": 2607, "taxBp": 500, "roundStepCents": 1000, "fundKey": "f_tax" },
  "budget": { "weeklyCents": 20000 },
  "funds": [ { "key": "f_tax", "name": "…", "kind": "tax|goal|reserve", "accountKey": "a", "parentKey": null, "provisional": false,
               "goal": { "targetCents": 100000 /* o null = da definire */, "minCents": 80000, "priority": 1, "deadline": "2026-12-30" } } ],
  "invoiceTemplates": [ { "client": "…", "cents": 120000, "reserveCents": 30000, "invoiceDay": 27, "collectDays": 12, "accountKey": "a", "review": false, "note": "" } ],
  "planned": [ { "name": "…", "kind": "subscription|renewal|investment|purchase|extraordinary", "cents": 2500, "recurrence": "monthly",
                 "accountKey": "a", "categoryId": "cat_subs", "confirm": null /* "date" | "active" */, "dueDay": null } ]
}
```

Importi in **centesimi**, percentuali in **punti base** (26,07% = 2607). Il file è validato prima di essere applicato; un profilo non valido
non cambia nulla.

## Regole sugli incassi professionali

* **Riserva fissa** per cliente (`reserveCents`): è la regola di default. Il resto dell'incasso è disponibilità personale e **non** viene
  proposto in automatico a nessun altro fondo.
* **Incasso parziale**: la riserva proposta è proporzionale a quanto effettivamente ricevuto; l'app tiene traccia di riserva *prevista*,
  *già accantonata* e *residua*. L'ultima rata completa esattamente la riserva fissa.
* **Importo definitivo diverso** dal previsto: l'app lo segnala e propone la riserva fissa, lasciandoti scegliere se mantenerla, ricalcolarla
  in proporzione o usare la stima del profilo fiscale. Vale per **quella fattura**: la regola dei mesi futuri non cambia mai da sola.
* **Compenso straordinario** (senza regola): riserva suggerita dal profilo fiscale, sempre modificabile.
* Tutto resta **virtuale** finché non confermi il bonifico reale (vedi "Bonifici da confermare").
