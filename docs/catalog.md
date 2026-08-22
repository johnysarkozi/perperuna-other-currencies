# Cross-backend katalóg (produkty, ceny, sklad)

## Prečo

Perperuna má 5 samostatných Shopify backendov (SK, CZ, RO, PL, HU), každý s
vlastnou menou a vlastným skladom. Bez spoločného miesta treba každú zmenu
ceny/skladu/obsahu robiť 5×. Tento katalóg je read-only zrkadlo všetkých
backendov na jednom mieste (Supabase), plus (v ďalšej fáze) miesto na úpravy,
ktoré sa rozpošlú do príslušných obchodov.

## Kde to žije

Supabase org **Perperuna**, projekt `jtxewgjpdmmbctbfvlaj`
(`martinmrva@me.com's Project` — zdieľaný projekt, katalóg používa vlastné
tabuľky s prefixom `catalog_`, nekoliduje s ostatnými appkami v ňom —
`pp_cashflow_*`, `weightpath_state`, `life_rpg`).

## Dátový model

Spájací kľúč medzi obchodmi je **SKU** — overené, že je konzistentné
(`PP-XXXX-YYY-NNN`), 39 SKU, 36 z nich sa vyskytuje aspoň v dvoch obchodoch.

- `catalog_products` — canonical zoznam SKU (jeden riadok = jeden variant,
  cez všetky obchody).
- `catalog_listings` — jeden riadok = jeden produktový variant v jednom
  obchode (cena, mena, sklad, stav, obrázok). Unique na `(store,
  shopify_variant_id)`.
- `catalog_sync_log` — audit trail budúcich zápisov (pull/push, čo sa zmenilo).

RLS je zapnuté na všetkých troch tabuľkách; prístup majú len prihlásení
používatelia (`authenticated` role), anon nič nevidí. Sync skripty používajú
`service_role` kľúč, ktorý RLS obchádza — nikdy sa nesmie dostať do prehliadača.

## Skripty

```
node scripts/catalog-pull.mjs              # stiahne CZ/RO/PL/HU do Supabase
node scripts/catalog-pull.mjs cz pl        # len vybrané backendy
```

Potrebuje navyše k Shopify credentials:

```
SUPABASE_URL=https://jtxewgjpdmmbctbfvlaj.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

`catalog-pull.mjs` je idempotentný (upsert), bezpečné spúšťať opakovane/na
cron. Zapisuje len do Supabase, do Shopify nič.

## Stav a ďalšie fázy

1. ✅ **Schéma + pull sync** — read-only zrkadlo, dá sa hneď prezerať cez
   Supabase Table Editor ako "jedno miesto na pozeranie".
2. ⏳ **Push sync** — zápis zmien (cena/sklad) z katalógu späť do konkrétneho
   backendu cez `lib/shopify.mjs`, s logovaním do `catalog_sync_log`.
3. ⏳ **UI** — malý dashboard (Netlify), namiesto priameho SQL/Table Editora.
   Zobrazenie matrice SKU × obchod, editácia, tlačidlo "push do obchodu X".

Fáza 2 a 3 zatiaľ nie sú postavené — momentálne toto je read-only prehľad,
úpravy stále treba robiť v jednotlivých Shopify adminoch.
