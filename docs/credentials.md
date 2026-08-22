# Pripojenie na Shopify backendy

## Princíp

Žiadne heslá v repe ani v chate. Repo nikdy neobsahuje token, client ID ani
secret — ani v kóde, ani v commite. Všetko sa berie z environment variables za
behu.

Autentifikácia je **client credentials grant**. Pre každý backend (`sk`, `cz`,
`ro`, `pl`, `hu`) existuje samostatná Shopify Custom App (v Dev Dashboarde)
s vlastným Client ID a Client Secret. Skript si tieto dve hodnoty za behu vymení
za prístupový token s 24-hodinovou platnosťou:

```
POST https://{shop}/admin/oauth/access_token
{ "grant_type": "client_credentials", "client_id": "...", "client_secret": "..." }
```

Nie je tam žiadny dlhoživý token, ktorý treba niekde uložiť, a **nie je potrebný
žiadny manuálny OAuth install flow v prehliadači** — appka musí byť len už
nainštalovaná na obchode.

## Premenné

Pre backend s kľúčom napr. `cz` treba tri premenné:

```
SHOPIFY_CZ_SHOP=perperuna-cz.myshopify.com
SHOPIFY_CZ_CLIENT_ID=...
SHOPIFY_CZ_CLIENT_SECRET=shpss_...
```

plus jednu spoločnú, ktorá hovorí, ktoré backendy sú zapnuté:

```
SHOPIFY_SHOPS=sk,cz,ro,pl,hu
```

Šablóna je v [`.env.example`](../.env.example).

## Kde sa premenné nastavujú (nie v chate, nie v `.env` v repe)

- **Claude Code na webe:** claude.ai/code → ikonka cloud prostredia nad message
  boxom → *Add cloud environment* (alebo ozubené koliesko pri existujúcom) →
  vložiť `.env` blok do *Environment variables* → uložiť → **spustiť novú
  session**. Bežiaca session hodnoty nevidí, načítajú sa len pri štarte
  kontajnera. Použiť **osobné**, nie organizačne zdieľané prostredie — zdieľané
  vidia všetci členovia org.
- **CI / GitHub Actions:** repo Settings → Secrets and variables → Actions →
  jeden secret na premennú.

Lokálny `.env` súbor je gitignored a v cloud session sa **nenačíta**. Ak niečo
nefunguje, toto je najčastejšia príčina.

## Overenie

```
node scripts/check-credentials.mjs            # všetky backendy zo SHOPIFY_SHOPS
node scripts/check-credentials.mjs cz pl      # len vybrané
node scripts/check-credentials.mjs --scopes   # vypíše aj zoznam scopes
```

Pre každý backend vypíše, či sú credentials nastavené, či sa dá reálne
vymintovať token, na ktorý obchod sa reálne dostane (odhalí prehodené
ID/secret medzi backendami) a koľko scopes appka má. Nikdy nevypíše hodnotu
žiadneho hesla.

> Pozn.: Shopify novším obchodom prideľuje náhodnú permanentnú `myshopifyDomain`
> (napr. `kabfbu-0r.myshopify.com`), takže sa líši od domény, na ktorú voláme.
> To je v poriadku — dôkazom správnosti je meno obchodu vo výpise.

## Predpoklady na Shopify strane

Musia byť splnené vopred, mimo tohto repa:

- appka a obchod sú v tej istej Shopify organizácii (Dev Dashboard),
- appka je nainštalovaná na obchode so správnymi scopes.

## Použitie v kóde

```js
import { graphql, forEachShop, paginate } from '../lib/shopify.mjs';

const data = await graphql('cz', '{ shop { name currencyCode } }');
const all  = await forEachShop((key) => graphql(key, '{ productsCount { count } }'));
```

`lib/shopify.mjs` si tokeny cachuje v pamäti na dobu behu procesu a pri 429/5xx
raz zopakuje požiadavku.
