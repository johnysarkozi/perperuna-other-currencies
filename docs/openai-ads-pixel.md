# OpenAI (ChatGPT) ads — measurement pixel

Kampane bežia zatiaľ len na **CZ**. Tento dokument popisuje, ako sa na CZ
backend dostane merací pixel z
[developers.openai.com/ads/measurement-pixel](https://developers.openai.com/ads/measurement-pixel),
čo meria a čo ešte nie.

## Prečo dve časti

OpenAI dokumentuje jediný snippet do `<head>`. Na Shopify to nestačí: téma
nebeží v košíku ani v checkoute (checkout extensibility), takže samotný snippet
v `theme.liquid` by nikdy nevidel objednávku. A opačne — custom pixel
(Settings → Customer events) beží v „lax" sandboxe, teda v iframe, ktorý nevidí
URL ani cookies vrchného rámca. To je podstatné, lebo SDK si podľa dokumentácie
berie `oppref` (identifikátor kliku) **z URL pristávacej stránky** a ukladá si
ho do first-party cookie `__oppref`.

Preto sú časti dve a eventy sú medzi ne rozdelené tak, aby sa neprekrývali:

| Kde | Súbor | Eventy |
|-----|-------|--------|
| téma, `<head>` každej stránky obchodu | [`pixel/openai-pixel.liquid`](../pixel/openai-pixel.liquid) | `page_viewed`, `contents_viewed` |
| custom pixel (Customer events) | [`pixel/openai-custom-pixel.js`](../pixel/openai-custom-pixel.js) | `items_added`, `checkout_started`, `order_created` |

Snippet v téme je ten, ktorý zachytáva `oppref` a cookie — beží na
`cz.perperuna.com`. Custom pixel doplní to, čo téma nevidí.

## Inštalácia

```
node scripts/openai-pixel.mjs cz                  # dry run — vypíše, čo by spravil
node scripts/openai-pixel.mjs cz --apply          # zapíše snippet do živej témy
node scripts/openai-pixel.mjs cz --print-pixel    # JS na vloženie do admina
node scripts/openai-pixel.mjs cz --remove --apply # odinštaluje snippet z témy
```

Pixel ID sa berie z `OPENAI_PIXEL_ID_CZ` (alebo `--pixel-id <id>`); v repe
nikde nie je, v súboroch je zástupný `__OPENAI_PIXEL_ID__`. ID sa vyrába
v Ads Manageri na karte *Conversions*.

Skript zapíše do témy `snippets/openai-pixel.liquid` a do `layout/theme.liquid`
pridá `{%- render 'openai-pixel' -%}` hneď pod `<meta name="viewport">`, teda čo
najvyššie v `<head>` (OpenAI to odporúča, aby sa nestratili skoré konverzie).
Bez `--apply` sa nezapisuje nič. `--theme <id>` cieli na inú tému, než je živá —
hodí sa na vyskúšanie na náhľade.

Custom pixel **cez Admin API vytvoriť nejde** (Shopify má API len pre pixely
appiek, nie pre custom pixely), vkladá sa ručne:

1. Shopify admin → Settings → Customer events → **Add custom pixel**, meno napr.
   `OpenAI ads`,
2. *Permission* nechať na **Marketing** (pixel je reklamný),
3. telo vložiť z `node scripts/openai-pixel.mjs cz --print-pixel`,
4. Save → **Connect**.

## Súhlas (cookie lišta)

CZ má zapnutú Shopify cookie lištu, takže obe časti štartujú s
`oaiq("consent", false)` a na `true` prepnú až po marketingovom súhlase:

- v téme cez `window.Shopify.customerPrivacy.marketingAllowed()` a udalosť
  `visitorConsentCollected`,
- v custom pixeli cez `init.customerPrivacy` a `api.customerPrivacy.subscribe`.

Zablokované eventy sa podľa dokumentácie neprehrávajú, preto sa `page_viewed`
odošle až po udelení súhlasu a custom pixel si eventy, ktoré prídu pred
súhlasom, podrží vo fronte a odošle ich, keď súhlas príde.

## Čo sa posiela

- **Sumy** sú celé čísla v minor units (haliere): OpenAI v príkladoch používa
  `amount: 2599` pre `USD` a v troubleshootingu žiada celé čísla. Liquid dáva
  ceny rovno v halieroch, web pixel API v korunách — preto sa v JS násobí stom.
  Po prvých objednávkach sa oplatí v Ads Manageri overiť, či hodnota konverzie
  sedí s reálnou tržbou (a nie je 100× vedľa).
- **`id` položky** je SKU, s pádom na ID varianty, keď SKU chýba. SKU je
  v tomto repe primárny kľúč katalógu ([`docs/sku.md`](sku.md)).
- **Advanced matching** je hashované SHA-256 v prehliadači (e-mail, telefón,
  meno, priezvisko + krajina/mesto/región/PSČ v čistej podobe, tak ako to
  dokumentácia žiada). V téme z prihláseného zákazníka, v custom pixeli
  z checkoutu — tam je identita aj pri objednávke bez konta.
- **`event_id`** je `order_<ID objednávky>` pri `order_created` a
  `checkout_<token>` pri `checkout_started`, aby sa event zdedupoval, keď
  pribudne server-side odosielanie.

## Čo zatiaľ chýba

`order_created` odchádza zo sandboxu, ktorý nevidí `__oppref` cookie
z pristávacej stránky. Priradenie objednávky ku kliku sa preto opiera hlavne
o advanced matching. Presnejšie by to bolo cez
[Conversions API](https://developers.openai.com/ads/conversions-api): webhook
`orders/create` → Edge Function → `POST https://bzr.openai.com/v1/events` s
`oppref` (téma by ho odložila do atribútu košíka), hashovanou identitou a tým
istým `event_id`, aké posiela pixel — takže by sa duplicity samy zahodili. Na to
treba API kľúč z Ads Manageru; kým nie je, pixel beží sám.

Ostatné backendy (RO/PL/HU) kampane nemajú a pixel na nich nie je. Skript ich
vie obslúžiť tiež — stačí kľúč obchodu a jeho `OPENAI_PIXEL_ID_<KEY>`.
