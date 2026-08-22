# perperuna-other-currencies

Nástroje pre prácu s ne-eurovými Shopify backendmi Perperuny: **CZ, RO, PL, HU**.
Každá doména je samostatný Shopify obchod s vlastnou menou a vlastnou custom
appkou.

SK backend (`perperuna-store.myshopify.com`, EUR) sa v tomto repe rieši len
okrajovo — je zapnutý v `SHOPIFY_SHOPS`, takže skripty ho zahrnú, ak ho
explicitne nevynecháš.

## Prístupy

Client credentials grant, credentials výhradne z environment variables.
Podrobne v [`docs/credentials.md`](docs/credentials.md). Nikdy nedávaj token,
client ID ani secret do kódu, commitu, ani do chatu.

```
node scripts/check-credentials.mjs      # over pripojenie na všetky backendy
node scripts/dump-context.mjs           # osviež snapshot obchodov
```

## Prehľad backendov

Snapshot z 2026-08-22, plné dáta v [`docs/shop-context.json`](docs/shop-context.json).

| Kľúč | Obchod | Doména | Mena | Locale | Produkty | Kolekcie | Objednávky /90d |
|------|--------|--------|------|--------|----------|----------|-----------------|
| `cz` | PERPERUNA.CZ | cz.perperuna.com | CZK | cs | 57 | 7 | 1576 |
| `ro` | PERPERUNA.RO | perperuna.ro | RON | ro | 50 | 7 | 0 |
| `pl` | PERPERUNA.PL | www.perperuna.pl | PLN | pl | 50 | 8 | 0 |
| `hu` | PERPERUNA.HU | perperuna.hu * | HUF | hu | 50 | 9 | 0 |

\* HU market má nastavenú web presence na `perperuna.hu`, ale `primaryDomain`
obchodu je stále `perperuna-hu.myshopify.com` — vlastná doména tam zrejme ešte
nie je dotiahnutá.

Spoločné pre všetky štyri: plán Shopify, timezone `Europe/Bratislava`, váhy
v kilogramoch, jedna lokácia na Slovensku, jeden aktívny market na obchod
s jedinou menou (žiadne local currencies). Iba CZ reálne beží — RO/PL/HU majú
za posledných 90 dní nula objednávok.

## Rozdiely medzi backendmi

- **Sales channels** — CZ má navyše Facebook & Instagram, Inbox, Google & YouTube;
  RO/PL/HU majú len Online Store + POS.
- **Metafields** — CZ nemá `custom.badges` (ostatné tri áno) a má navyše
  `shopify.color-pattern`, `shopify.skin-care-effect`,
  `mm-google-shopping.custom_product`.
- **Metaobjects** — všade `recenzia`, `navod`, `faq_polozka`, `benefit_vone`;
  CZ navyše `shopify--color-pattern`, `shopify--skin-care-effect`;
  PL navyše `doran_shoppable_videos_translation`.
- **Kontaktný e-mail** — CZ/PL `info@perperuna.sk`, RO/HU `sarkozi.jan@gmail.com`.
- **Formát ceny** — HU je bez desatinných miest (`{{amount_no_decimals_with_comma_separator}} Ft`).

## Štruktúra

```
lib/shopify.mjs             multi-backend Admin API klient (token cache, retry, pagination)
scripts/check-credentials.mjs  overenie prístupov
scripts/dump-context.mjs       read-only snapshot obchodov → docs/shop-context.json
docs/credentials.md            ako sa nastavujú prístupy
docs/shop-context.json         posledný snapshot
```

## Konvencie

- Node ESM (`.mjs`), bez závislostí — len vstavaný `fetch`.
- Admin API verzia je jedna konštanta: `API_VERSION` v `lib/shopify.mjs`.
- Skripty, ktoré čokoľvek menia, musia mať dry-run režim a vypísať, čo by spravili.
- Backend sa vždy adresuje kľúčom (`cz`, `ro`, `pl`, `hu`), nikdy natvrdo doménou.
