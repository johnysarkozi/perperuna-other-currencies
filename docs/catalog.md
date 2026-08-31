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
- **filter „len aktívne"** (zapnutý defaultne) — skryje riadky, ktoré sa nikde
  nedajú kúpiť, teda všade DRAFT/ARCHIVED. UNLISTED sa počíta ako kupiteľné
  (priamy link funguje), takže sa neskrýva
- **filter „len problémy"** — nechá len riadky s nejakým príznakom
- **filter „len rozdiely oproti SK"** — riadky, kde je aspoň jeden trh v inom
  stave než SK; porovnáva sa stav proti stavu, nie „predáva sa / nepredáva"
- **zoradenie** kliknutím na hlavičku ktoréhokoľvek stĺpca (druhý klik otočí smer)
- **úprava SK skladu** priamo v tabuľke, viď nižšie
- tlačidlo **Ako to funguje** — modál s pravidlami: odkiaľ sa berú sklady,
  ako často sa zrkadlia, čo znamenajú farby a čo robia tlačidlá
- tlačidlo **SKU kľúč** — modál s vysvetlením, ako sa tvoria SKU kódy
  (obsah zrkadlí [`docs/sku.md`](sku.md); pri zmene uprav oboje)
- tlačidlá **Zrkadliť zo SK** a **Načítať zo Shopify**
- **prepočet zahraničných cien do €** pod cenou, aj s odchýlkou od SK
- **úprava cien** (aj ceny pred zľavou) pre všetkých päť trhov — klik na cenu
- **zmena stavu** produktu na ktorýkoľvek zo štyroch — klik na bodku
- **pohľad na jeden obchod** listing po listingu — klik na názov krajiny

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

### CORS

Všetky tri funkcie posielajú CORS hlavičky a odpovedajú na `OPTIONS`. Bez toho
prehliadač request vôbec neodošle — preflight zlyhá a v appke sa to prejaví
len ako `Failed to fetch`. Cez `curl` sa to neodhalí, ten preflight nerobí.

Povolený origin je `*.netlify.app`, inak primárna adresa appky. Pri presune na
vlastnú doménu treba `PRIMARY_ORIGIN` vo funkciách upraviť.

### Poistky

- SKU musí už existovať v katalógu — endpoint sklad upravuje, nezakladá produkty.
- Množstvo musí byť celé číslo 0 – 1 000 000.
- SK sa zapisuje ako prvé; ak zlyhá, ostatné obchody sa nechajú tak.
- Každá zmena ide do `catalog_sync_log` s `actor = 'inventory-set'`.

## Zapnutie a vypnutie produktu na trhu

Pri každej cene v matici je bodka so stavom produktu v tom obchode: zelená =
`ACTIVE`, prázdna = `DRAFT`, oranžová = `UNLISTED`, sivá = `ARCHIVED`,
bodkovaná = SKU tam vôbec nie je.

Klik na bodku otvorí ponuku **všetkých štyroch stavov** — Edge Function
**`product-status`**. Rozdiel medzi nimi nie je len vizuálny:

| Stav | Čo znamená | Prenáša sa? |
|------|------------|-------------|
| `ACTIVE` | v predaji | rozhodnutie za skupinu — zo SK ide do všetkých |
| `DRAFT` | mimo predaja, ostáva v admine | rozhodnutie za skupinu — zo SK ide do všetkých |
| `UNLISTED` | mimo ponuky a vyhľadávania, cez priamy link kupiteľný | len ten listing |
| `ARCHIVED` | ukončený, URL vráti 404, história ostáva | len ten listing |

```
POST /functions/v1/product-status
{ "sku": "PP-CUBE-LOVE-020", "store": "sk", "status": "DRAFT", "password": "…" }
{ "sku": "PP-CUBE-CALM-004", "store": "cz", "status": "ARCHIVED",
  "productId": "gid://shopify/Product/123", "password": "…" }
```

`ACTIVE`/`DRAFT` zo SK sa rozpošlú do ostatných backendov, a to len na listingy,
ktoré sú samy `ACTIVE` alebo `DRAFT`. `UNLISTED` a `ARCHIVED` ostávajú tam, kde
sa nastavia — sú to rozhodnutia o jednom listingu na jednom trhu a `inventory-mirror`
sa ich nedotkne. Práve preto sú jediným podporovaným spôsobom, ako mať jeden trh
zámerne inak, a spôsobom, ako ukončiť kampaňovú kópiu.

`productId` mieri na konkrétny listing. Bez neho sa SKU dohľadá podľa kódu
a SKU sediace na viacerých produktoch sa odmietne — čo je pri katalógu plnom
kampaňových kópií bežné a presne vtedy by hádanie bolelo najviac. Appka
`productId` posiela vždy, takže sa dá archivovať práve ten duplikát, na ktorý
klikneš.

> **API verzia.** `UNLISTED` je nový Shopify status, ktorý sa dá *zapisovať* až
> od `2025-10`; `product-status` preto beží na `2026-07`. Verzia `2025-07`,
> na ktorej stoja ostatné funkcie, už nie je medzi podporovanými
> (`{ publicApiVersions }` vracia `2025-10` … `2026-07`) — pri ďalšom zásahu
> ich treba posunúť tiež.

## Pohľad na jeden obchod

Klik na názov krajiny v hlavičke matice otvorí **všetko, čo v tom obchode je —
listing po listingu**, nie jeden riadok na SKU. Matica skladá viac listingov
toho istého SKU do jednej bunky, takže kampaňové kópie, zabudnuté „v2" verzie
a duplicity v nej z princípu nevidno; tento pohľad je ten druhý koniec.

- riadky s tým istým SKU sú podfarbené a zoradené k sebe, živý listing prvý,
- poznámky označia `N× rovnaké SKU`, `kampaňová kópia` (názov nesie `(-50%)`,
  `(−25 %)` alebo `v2`) a `nie je na SK`,
- stav sa mení priamo tam a mení sa presne ten listing, na ktorý klikneš,
- filter **len s poznámkou** nechá iba to, čo treba doriešiť.

Na CZ takto vidno 67 listingov na 55 SKU, z toho 23 riadkov v duplicitách —
proti 61 listingom a žiadnym duplicitám na PL/RO/HU.

### Poistky

- Heslo je to isté ako pri úprave skladu (`catalog_settings.edit_password_sha256`).
- Cieľový stav môže byť len `ACTIVE` alebo `DRAFT`.
- SK sa zapisuje ako prvé; ak zlyhá, ostatné obchody sa nechajú tak.
- Ak jedno SKU sedí v tom obchode na viacerých `ACTIVE`/`DRAFT` produktoch,
  endpoint ho neprepne — hádať, ktorý, by bolo horšie než nič. V klikanom
  obchode je to chyba, pri rozposielaní len preskočenie (`skipped: ambiguous`),
  rovnako ako SKU, ktoré v tom obchode nie je (`skipped: absent`).
- Shopify hľadá `sku:` prefixovo, takže sa zhoda ešte overuje na presnú rovnosť.
- Každá zmena ide do `catalog_sync_log` s `actor = 'product-status'` a rovno sa
  premietne do `catalog_listings` (len do `ACTIVE`/`DRAFT` riadkov), aby bodky
  preskočili bez čakania na sync.

## Úprava cien z appky

Klik na ktorúkoľvek cenu v matici otvorí editor cien pre to SKU — **všetkých
päť trhov naraz**, v každom `cena` a `cena pred zľavou` (Shopify
`compareAtPrice`). Prečiarknutá cena v tabuľke znamená, že tam produkt beží ako
zľavnený. Zapisuje Edge Function **`price-set`**.

```
POST /functions/v1/price-set
{
  "sku": "PP-CUBE-CALM-004",
  "changes": [
    { "store": "sk", "variantId": "gid://shopify/ProductVariant/1", "price": 4.49, "compareAtPrice": 5.99 },
    { "store": "cz", "variantId": "gid://shopify/ProductVariant/2", "price": 109 }
  ],
  "password": "…"
}
```

Ceny sa **nezrkadlia zo SK** — každý backend má vlastnú menu aj cenovú hladinu,
takže nie je čo kopírovať. Tlačidlo **Prepočítať zo SK** len predvyplní
zahraničné polia kurzom ECB a zaokrúhli podľa zvyklosti obchodu (CZK na celé,
PLN a RON na `,90`, HUF na desiatky). Je to návrh — zapíše sa presne to, čo
zostane v poli.

### Poistky

- Heslo je to isté ako pri sklade (`catalog_settings.edit_password_sha256`).
- Každá zmena nesie `variantId` toho listingu, ktorý bol v tabuľke, a funkcia
  overí, že ten variant naozaj nesie dané SKU. Preto sa nedá omylom precenať
  „(-50%)" kópia toho istého SKU.
- Najprv sa načítajú a skontrolujú **všetky** trhy a až potom sa zapisuje —
  preklep v poslednom trhu nenechá predošlé už precenené.
- `compareAtPrice` nižšia než `price` sa odmietne; v obchode by sa neukázala
  a vyzeralo by to rozbito. `null` ju zruší, vynechaný kľúč ju nechá tak.
- Zapisuje sa len to, čo sa naozaj líši; každé pole ide do `catalog_sync_log`
  ako `price` alebo `compare_at_price` s `actor = 'price-set'` a rovno sa
  premietne do `catalog_listings`.

## Prepočet zahraničných cien do €

Pod každou cenou v CZ/PL/RO/HU je `≈` suma v eurách a odchýlka od ceny na SK
v percentách. Od **10 %** vyššie sa zvýrazní oranžovo — nie je to nutne chyba
(iné dane, iná cenová hladina, zaokrúhlenie), ale je to zoznam na prejdenie.
Bublinka ukáže presný kurz aj cenu na SK, s ktorou sa porovnáva.

Kurzy sú referenčné kurzy ECB z <https://api.frankfurter.dev> (bez kľúča,
CORS povolený), ťahané pri načítaní stránky a odkladané do `localStorage`,
takže výpadok API neodstráni prepočet, len ho nechá na poslednom známom kurze.
Dátum kurzov je v hlavičke vpravo. Je to orientačný prepočet na kontrolu
nacenenia, nie účtovný kurz — ceny sa nikde neprepočítavajú ani nezapisujú.

Pri poslednej kontrole malo 62 z 221 buniek odchýlku ≥ 10 %; najvýraznejšie
čaje do kúpeľa (`PP-BATE-*`, v zahraničí o 38–51 % lacnejšie než na SK)
a vrecúško `PP-ACCS-SPOU-011` (na PL/RO/HU vyše 3× drahšie). Pozor, časť
rozdielov je legitímna — napr. `PP-NUBE-NEDO-020` je na CZ balenie 10 ks,
kým na SK je to jedna kocka.

## Ako sa dajú nájsť tichí zabijaci katalógu

Matica ukazuje **jeden listing na obchod** (preferuje ACTIVE, pri zhode drahší).
To je čitateľné, ale samo osebe to dvakrát klame — obe diery sú zaplátané:

1. **Skrytý dvojník.** To isté SKU môže v jednom obchode sedieť na viacerých
   produktoch, ku ktorým sa zákazník dostane (ACTIVE alebo UNLISTED) — napr. na
   CZ je pri kockách bežná verzia UNLISTED a „(-50%)" kópia ACTIVE, pri
   `PP-CUBE-REFR-033` sú ACTIVE dokonca obe. V tabuľke bol vidno vždy len jeden
   z nich. Bunka teraz nesie značku `2×` so zoznamom všetkých takých listingov
   v bublinke a príznak ide aj do filtra **len problémy**.
2. **Unlisted ako „predáva sa".** Rozdiely medzi trhmi sa porovnávali cez
   „predáva sa / nepredáva", kde UNLISTED patrilo k predáva sa. Trh, ktorý mal
   produkt potichu unlisted, kým na SK bežal normálne, tak nevyzeral ako
   rozdiel. Teraz sa porovnáva **stav proti stavu SK** a filter sa volá
   **len rozdiely oproti SK**; chýbajúce SKU je tiež rozdiel.

Zrkadlenie na tieto prípady zámerne nesiaha (UNLISTED je samostatné
rozhodnutie) — appka ich má nájsť, opravujú sa ručne v Shopify admine.

## Hmotnosti

`scripts/weight-mirror.mjs` kopíruje hmotnosti variantov zo SK podľa SKU,
rovnako ako `inventory-mirror` kopíruje sklad. Na rozdiel od skladu je
hmotnosť statická vlastnosť, takže stačí pustiť raz po zmene katalógu.

```
node scripts/weight-mirror.mjs                          # dry run
node scripts/weight-mirror.mjs ro pl --apply            # zápis
node scripts/weight-mirror.mjs cz --apply --skip=SKU    # vynechať SKU
```

`--skip` je pre SKU, ktoré znamená v každom obchode niečo iné — napr.
`PP-NUBE-NEDO-020` je na SK jedna kocka, ale na CZ balenie 10 ks, takže SK
hmotnosť by tam bola nesprávna.

Skript preferuje SK listing, ktorý hmotnosť naozaj má, a nesahá na položky,
ktoré sa neposielajú (`FEE-*` služby).

## Zrkadlenie skladov a zapnutia zo SK

SK je zdroj pravdy pre sklad **aj pre to, či je produkt zapnutý**. Ostatné
backendy sa naň dorovnávajú podľa SKU — Edge Function **`inventory-mirror`**.

```
POST /functions/v1/inventory-mirror
{}                      -> všetky backendy okrem sk
{ "stores": ["pl"] }    -> len vybrané
{ "dryRun": true }      -> vypíše, čo by zmenil, nezapíše nič
```

Zapisuje len tam, kde sa číslo líši, a každý zápis zaloguje do
`catalog_sync_log` (staré → nové), takže sa dá spätne dohľadať, čo sa menilo.
Sklad ide cez `inventory_quantity`, stav cez `field = 'status'`.

### Ktorý stav sa zrkadlí

Len medzi `ACTIVE` a `DRAFT`, a to na oboch stranách:

- Na SK je zdrojom stavu len `ACTIVE` alebo `DRAFT` listing. Archivovaná či
  unlisted kópia toho istého SKU (typicky „-25 %") o ostatných trhoch nehovorí
  nič. Ak je na SK viac listingov, vyhráva `ACTIVE` — rovnako ako pri sklade.
- V cieľovom obchode sa prepínajú tiež len `ACTIVE`/`DRAFT` produkty. `UNLISTED`
  a `ARCHIVED` sú samostatné rozhodnutia o tom listingu, takže sa ich mirror
  nedotkne — a je to zároveň spôsob, ako urobiť výnimku pre jeden trh.
- Ak jeden produkt v cieli nesie viac SKU, ktoré SK prepína rozdielne, mirror ho
  preskočí a započíta do `statusConflicts` v odpovedi.

Odpoveď má okrem `written` (sklad) aj `statusWritten` a per obchod
`statusChanged` / `statusWritten` / `statusConflicts`.

Rovnakú logiku pre **sklad** sa dá pustiť aj lokálne cez
`node scripts/inventory-mirror.mjs [--enable-tracking] [--apply]` — hodí sa na
jednorazové zásahy, lebo vypisuje jednotlivé varianty. Stav lokálny skript
nezrkadlí, ten rieši len Edge Function.

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

Sklad aj zapnutie sa menia **len na SK**. Úpravy priamo na CZ/RO/PL/HU
najbližší beh prepíše.

## Stav a ďalšie fázy

1. ✅ **Schéma** — `catalog_products` / `catalog_listings` / `catalog_sync_log`.
2. ✅ **Sync** — Edge Function `catalog-sync`.
3. ✅ **Cron** — `pg_cron` + `pg_net`, mirror každých 15 min, sync po ňom.
4. ✅ **Zrkadlenie skladov a zapnutia** — Edge Function `inventory-mirror`, s logom.
5. ✅ **UI** — dashboard na Netlify, matica SKU × obchod + obe tlačidlá.
6. ✅ **Úprava skladu z appky** — Edge Function `inventory-set`, chránená heslom.
6b. ✅ **Zapnutie/vypnutie produktu** — Edge Function `product-status`, bodka
   pri cene + filter rozdielov. Riadi sa zo SK a rozpošle sa do všetkých
   obchodov.
6c. ✅ **Hmotnosti** — `scripts/weight-mirror.mjs`, jednorazovo zo SK.
7. ✅ **Ceny** — Edge Function `price-set`, editor cien pre všetkých päť trhov
   naraz vrátane ceny pred zľavou, plus prepočet do € kurzom ECB s návrhom
   zaokrúhlenia. Zrkadliť sa zámerne nezrkadlia — každý trh má vlastnú menu
   aj cenovú hladinu.
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
