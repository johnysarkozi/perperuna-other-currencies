# Cross-backend katalóg (produkty, ceny, sklad)

## Prečo

Perperuna má 5 samostatných Shopify backendov (SK, CZ, RO, PL, HU), každý
s vlastnou menou a vlastným skladom. Bez spoločného miesta treba každú zmenu
ceny/skladu/obsahu robiť 5×. Katalóg je jedno miesto, kde vidíš všetky
backendy naraz — a v ďalšej fáze aj miesto, odkiaľ sa dá zapisovať späť.

## Kde to žije

Supabase org **Perperuna**, projekt `jtxewgjpdmmbctbfvlaj`
(`martinmrva@me.com's Project`). Katalóg používa vlastné tabuľky s prefixom
`catalog_`, takže nekoliduje s ostatnými appkami v tom istom projekte
(`pp_cashflow_*`, `weightpath_state`, `life_rpg`, `kv_store`).

## Dátový model

Spájací kľúč medzi obchodmi je **SKU** — overené, že je konzistentné naprieč
backendmi (`PP-XXXX-YYY-NNN`), 57 SKU celkovo, 238 listingov.

- `catalog_products` — canonical zoznam SKU.
- `catalog_listings` — jeden riadok = jeden variant v jednom obchode (cena,
  mena, sklad, stav, obrázok, Shopify `gid`). Unique na
  `(store, shopify_variant_id)`.
- `catalog_sync_log` — audit trail pre budúce zápisy späť do Shopify.

RLS je zapnuté na všetkých troch tabuľkách. `anon` rola (appka v prehliadači)
má povolené **iba čítanie** `catalog_products` a `catalog_listings`; zapisovať
môžu len Edge Functions cez secret kľúč. Podrobnosti nižšie v *Prístup*.

## Ako beží sync

Edge Function **`catalog-sync`** (kód v
[`supabase/functions/catalog-sync/index.ts`](../supabase/functions/catalog-sync/index.ts)).
Beží serverovo v Supabase: sama si vymintuje Shopify tokeny cez client
credentials, prejde všetky backendy a zapíše do katalógu. Service role kľúč
jej Supabase injektuje automaticky, takže nikde nefiguruje v tomto repe ani
v Claude prostredí.

```
POST /functions/v1/catalog-sync
{}                     -> všetky backendy zo SHOPIFY_SHOPS okrem sk
{ "stores": ["pl"] }   -> len vybrané
```

Je idempotentná (upsert), takže sa dá bezpečne púšťať opakovane aj na cron.

### Čo treba nastaviť raz

Funkcia potrebuje Shopify credentials ako **secrets Edge Functions**
(Supabase dashboard → Project Settings → Edge Functions → Secrets). Rovnaké
hodnoty ako v cloud prostredí Claude Code:

```
SHOPIFY_SHOPS
SHOPIFY_CZ_SHOP   SHOPIFY_CZ_CLIENT_ID   SHOPIFY_CZ_CLIENT_SECRET
SHOPIFY_RO_SHOP   SHOPIFY_RO_CLIENT_ID   SHOPIFY_RO_CLIENT_SECRET
SHOPIFY_PL_SHOP   SHOPIFY_PL_CLIENT_ID   SHOPIFY_PL_CLIENT_SECRET
SHOPIFY_HU_SHOP   SHOPIFY_HU_CLIENT_ID   SHOPIFY_HU_CLIENT_SECRET
```

(SK len ak ho chceš mať v katalógu tiež.)

Kým secrets nie sú nastavené, funkcia vráti `missing secret SHOPIFY_..._SHOP`.

## Lokálny náhľad bez zápisu

`scripts/catalog-pull.mjs` robí to isté čítanie zo Shopify, ale nič nezapisuje
— vypíše SQL na stdout. Slúži na kontrolu, čo by sa synclo, bez zásahu do
databázy:

```
node scripts/catalog-pull.mjs            # všetky backendy okrem sk
node scripts/catalog-pull.mjs cz pl      # len vybrané
```

Bežný sync rob cez Edge Function, nie týmto.

## Appka

Celá appka je jeden statický súbor: [`app/index.html`](../app/index.html).
Žiadny build krok, žiadne závislosti okrem Supabase JS z CDN.

Matica SKU × obchod — cena a sklad všetkých piatich backendov vedľa seba.
Farebne označuje záporný sklad, vypredané ACTIVE položky, odchýlku od SK
a SKU, ktoré v niektorom obchode chýba.

- **hľadanie** podľa SKU alebo názvu
- **filter „len aktívne"** (zapnutý defaultne) — skryje DRAFT/ARCHIVED/UNLISTED
- **filter „len problémy"** — nechá len riadky s nejakým príznakom
- **zoradenie** kliknutím na hlavičku ktoréhokoľvek stĺpca (druhý klik otočí smer)
- **úprava SK skladu** priamo v tabuľke, viď nižšie
- tlačidlá **Zrkadliť zo SK** a **Načítať zo Shopify**

### Prístup

Appka nemá vlastné prihlasovanie. Chráni ju **heslo na Netlify**
(Site configuration → Access control → Password protection).

V RLS má `anon` rola povolené **iba čítanie** katalógových tabuliek. Publishable
kľúč je v zdrojovom kóde stránky, takže platí: kto ten kľúč získa, prečíta si
katalóg aj mimo Netlify hesla. Zapisovať cez API sa ním nedá (overené — REST
zápis vracia 401). Sklady a ceny sú teda chránené „len" tým heslom, nie
kryptograficky — pre interný nástroj s týmto obsahom je to vedomý kompromis
za pohodlie.

Ak by to raz malo byť prísnejšie, návrat k Supabase Auth je malá zmena:
odstrániť tie dve `anon read` politiky a vrátiť prihlasovaciu obrazovku.

### Hosting

Netlify projekt **multistore-manage-perperuna**
(<https://multistore-manage-perperuna.netlify.app/>), site id
`9b190647-11b7-4b7a-9eeb-454856bed7e5`, tím `martinmrva`.

Publish adresár je `app/`, build command žiadny — nastavené v
[`netlify.toml`](../netlify.toml).

Najlepšie je mať projekt **napojený na GitHub repo** (Site configuration →
Build & deploy → Link repository), potom sa každý push nasadí sám.

Ad-hoc deploy z tohto prostredia sa dá vyvolať cez Netlify MCP
(`deploy-site` vráti `npx @netlify/mcp …` príkaz s dočasným proxy tokenom,
ktorý sa spustí v koreni repa).

**Edge Function na hosting HTML nefunguje** — Supabase gateway prepisuje
odpoveď na `content-type: text/plain` a pridáva
`content-security-policy: default-src 'none'; sandbox`. Stránka sa zobrazí
ako holý text a skripty sa nespustia. Je to zámerné opatrenie Supabase, nedá
sa obísť z kódu funkcie. Prvý pokus (`supabase/functions/catalog-ui/`) preto
skončil slepou uličkou.

### Čo treba nastaviť raz

Na Netlify zapnúť ochranu heslom: Site configuration → Access control →
Password protection. Nič v Supabase nastavovať netreba.

> Overiť sa to dá cez Netlify MCP `get-project` — v `projectAccessControls`
> musí byť `requiresPassword: true`. Kým je `false`, appka je verejná
> a ktokoľvek s odkazom vidí sklady a ceny všetkých obchodov.

## Úprava skladu z appky

V stĺpci **SK sklad** sa dá číslo prepísať priamo v tabuľke. Po potvrdení sa
nastaví na SK *aj vo všetkých ostatných obchodoch naraz* — Edge Function
**`inventory-set`**.

```
POST /functions/v1/inventory-set
{ "sku": "PP-CUBE-CALM-004", "quantity": 120, "password": "…" }
```

Editovateľný je zámerne len SK. Zmena na CZ/RO/PL/HU by nemala zmysel —
najbližší mirror by ju prepísala.

### Prečo pýta heslo

Stránka komunikuje so Supabase publishable kľúčom, ktorý je viditeľný v jej
zdrojovom kóde. Na čítanie katalógu to stačí, ale tento endpoint mení
**produkčný sklad na piatich obchodoch**, takže by ho nemal odomykať kľúč,
ktorý sa dá zo stránky vytiahnuť. Heslo je uložené ako SHA-256 v tabuľke
`catalog_settings`, ktorá nemá žiadnu RLS politiku — teda ju anon kľúč
neprečíta, vidia ju len Edge Functions cez secret kľúč.

Prehliadač si heslo pamätá v `sessionStorage` (do zatvorenia karty), takže sa
pýta raz. Zmena hesla:

```sql
update public.catalog_settings
set value = encode(digest('nove-heslo', 'sha256'), 'hex'), updated_at = now()
where key = 'edit_password_sha256';
```

(vyžaduje `pgcrypto`; inak si hash vyrob mimo databázy)

### Poistky

- SKU musí už existovať v katalógu — endpoint sklad upravuje, nezakladá produkty.
- Množstvo musí byť celé číslo 0 – 1 000 000.
- SK sa zapisuje ako prvé; ak zlyhá, ostatné obchody sa nechajú tak.
- Každá zmena ide do `catalog_sync_log` s `actor = 'inventory-set'`.

## Zrkadlenie skladov zo SK

SK je zdroj pravdy pre sklad. Ostatné backendy sa naň dorovnávajú podľa SKU —
Edge Function **`inventory-mirror`**.

```
POST /functions/v1/inventory-mirror
{}                      -> všetky backendy okrem sk
{ "stores": ["pl"] }    -> len vybrané
{ "dryRun": true }      -> vypíše, čo by zmenil, nezapíše nič
```

Zapisuje len tam, kde sa číslo líši, a každý zápis zaloguje do
`catalog_sync_log` (staré → nové), takže sa dá spätne dohľadať, čo sa menilo.

Rovnaká logika sa dá pustiť aj lokálne cez
`node scripts/inventory-mirror.mjs [--enable-tracking] [--apply]` — hodí sa na
jednorazové zásahy, lebo vypisuje jednotlivé varianty.

### Cron

```
inventory-mirror   */15 * * * *          každých 15 min
catalog-sync       5,20,35,50 * * * *    pár minút po mirrore
```

Naplánované cez `pg_cron` + `pg_net`. Stav: `select * from cron.job;`,
história behov: `select * from cron.job_run_details order by start_time desc;`.

### Čo zrkadlenie nerieši

Je to **jednosmerná kópia v čase, nie zdieľaný sklad**. Medzi behmi sa čísla
rozchádzajú — predaj na PL neodpočíta CZ. Pri 15-minútovom intervale je
rozdiel malý, ale pri súbežnom dopredaji posledných kusov na dvoch trhoch sa
dá predať viac, než je fyzicky na sklade. Skutočné riešenie by bol jeden
zdieľaný sklad (napr. cez Shopify webhooky na `inventory_levels/update`
namiesto pollovania) — to zatiaľ postavené nie je.

Sklad sa mení **len na SK**. Úpravy priamo na CZ/RO/PL/HU najbližší beh
prepíše.

## Stav a ďalšie fázy

1. ✅ **Schéma** — `catalog_products` / `catalog_listings` / `catalog_sync_log`.
2. ✅ **Sync** — Edge Function `catalog-sync`.
3. ✅ **Cron** — `pg_cron` + `pg_net`, mirror každých 15 min, sync po ňom.
4. ✅ **Zrkadlenie skladov** — Edge Function `inventory-mirror`, s logom.
5. ✅ **UI** — dashboard na Netlify, matica SKU × obchod + obe tlačidlá.
6. ✅ **Úprava skladu z appky** — Edge Function `inventory-set`, chránená heslom.
7. ⏳ **Ceny** — katalóg ich ukazuje, ale nemení. Zrkadlenie cien nedáva
   zmysel priamo (iné meny), chcelo by to prepočet cez kurz + pravidlá
   zaokrúhlenia.
8. ⏳ **Zdieľaný sklad namiesto kópie** — webhooky `inventory_levels/update`
   zo SK namiesto pollovania.

## Poznámky z prvého behu

- V katalógu sú aj neproduktové SKU: `FEE-FAST`, `FEE-GIFT`, `FEE-PAPER`,
  `FEE-SAFE`, `FEE-SMALL` (príplatky) a `BUNDLE-1/2/3`. Sú to reálne Shopify
  produkty, takže tam patria, ale pri UI ich bude treba vizuálne oddeliť od
  skutočného tovaru.
- Niektoré SKU sa opakujú v rámci jedného obchodu na viacerých produktoch
  (napr. `PP-CUBE-BALA-003` má na CZ bežnú aj `-50%` verziu). Preto je
  unique kľúč `(store, shopify_variant_id)`, nie `(store, sku)`.
