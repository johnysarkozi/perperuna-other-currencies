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

RLS je zapnuté na všetkých troch tabuľkách, prístup má len `authenticated`
role — anon (verejný) kľúč nevidí nič.

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

Matica SKU × obchod — cena a sklad všetkých piatich backendov vedľa seba,
hľadanie, filter „len problémy" a tlačidlo na okamžitý sync zo Shopify.
Farebne označuje záporný sklad, vypredané ACTIVE položky, odchýlku od SK
a SKU, ktoré v niektorom obchode chýba.

Prihlásenie je cez Supabase Auth (odkaz do e-mailu). Stránka samotná
neobsahuje žiadne dáta — všetko čítanie ide cez RLS, takže neprihlásený
nevidí nič.

### Hosting

Nasadzuje sa na **Netlify** ako statická stránka (drag & drop súboru na
<https://app.netlify.com/drop>, alebo napojenie repa s publish adresárom
`app/`).

**Edge Function na hosting HTML nefunguje** — Supabase gateway prepisuje
odpoveď na `content-type: text/plain` a pridáva
`content-security-policy: default-src 'none'; sandbox`. Stránka sa zobrazí
ako holý text a skripty sa nespustia. Je to zámerné opatrenie Supabase, nedá
sa obísť z kódu funkcie. Prvý pokus (`supabase/functions/catalog-ui/`) preto
skončil slepou uličkou.

### Čo treba nastaviť raz

V Supabase → Authentication → URL Configuration pridať medzi **Redirect URLs**
adresu, na ktorej appka reálne beží, napr.:

```
https://<nieco>.netlify.app
```

Bez toho odkaz z e-mailu po kliknutí neprihlási.

## Stav a ďalšie fázy

1. ✅ **Schéma** — `catalog_products` / `catalog_listings` / `catalog_sync_log`,
   RLS zapnuté.
2. ✅ **Sync** — Edge Function `catalog-sync` nasadená. Čaká na doplnenie
   Shopify secrets, potom je katalóg živý.
3. ⏳ **Cron** — naplánovať pravidelné spúšťanie (`pg_cron` +
   `net.http_post`, alebo Supabase Scheduled Functions).
4. ⏳ **Zápis späť** — meniť cenu/sklad z katalógu a rozposlať do konkrétneho
   backendu, s logom do `catalog_sync_log`.
5. ⏳ **UI** — dashboard (Netlify) s maticou SKU × obchod, editáciou a
   tlačidlom „pushni do obchodu X".

Do dokončenia fázy 4 je katalóg **read-only prehľad** — úpravy stále treba
robiť v jednotlivých Shopify adminoch.

## Poznámky z prvého behu

- V katalógu sú aj neproduktové SKU: `FEE-FAST`, `FEE-GIFT`, `FEE-PAPER`,
  `FEE-SAFE`, `FEE-SMALL` (príplatky) a `BUNDLE-1/2/3`. Sú to reálne Shopify
  produkty, takže tam patria, ale pri UI ich bude treba vizuálne oddeliť od
  skutočného tovaru.
- Niektoré SKU sa opakujú v rámci jedného obchodu na viacerých produktoch
  (napr. `PP-CUBE-BALA-003` má na CZ bežnú aj `-50%` verziu). Preto je
  unique kľúč `(store, shopify_variant_id)`, nie `(store, sku)`.
