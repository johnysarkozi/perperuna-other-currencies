# OpenAI (ChatGPT) ads — measurement pixel

Kampane bežia zatiaľ len na **CZ**. Tento dokument popisuje, ako sa na CZ
backend dostane merací pixel z
[developers.openai.com/ads/measurement-pixel](https://developers.openai.com/ads/measurement-pixel),
čo meria a čo ešte nie.

## Prečo dve časti

OpenAI dokumentuje jediný snippet do `<head>`. Na Shopify to nestačí: téma
nebeží v košíku ani v checkoute (checkout extensibility), takže samotný snippet
v `theme.liquid` by nikdy nevidel objednávku. A opačne — custom pixel
(Settings → Customer events) beží v „lax" sandboxe, teda v iframe, ktorého
`window.location` je URL sandboxu a nie stránky, a ktorý nemá prístup ku cookies
vrchného rámca. To je podstatné, lebo SDK si podľa dokumentácie berie `oppref`
(identifikátor kliku) **z URL pristávacej stránky** a ukladá si ho do
first-party cookie `__oppref` — v sandboxe teda nenájde ani jedno.

Preto sú časti dve a eventy sú medzi ne rozdelené tak, aby sa neprekrývali:

| Kde | Súbor | Eventy |
|-----|-------|--------|
| téma, `<head>` každej stránky obchodu | [`pixel/openai-pixel.liquid`](../pixel/openai-pixel.liquid) | `page_viewed`, `contents_viewed` |
| custom pixel (Customer events) | [`pixel/openai-custom-pixel.js`](../pixel/openai-custom-pixel.js) | `items_added`, `checkout_started`, `order_created` |

Snippet v téme je ten, ktorý zachytáva `oppref` a cookie — beží na
`cz.perperuna.com`. Custom pixel doplní to, čo téma nevidí.

## Prečo nie iným spôsobom

Shopify ponúka na cudzí JavaScript viac ciest a väčšina z nich pre tento pixel
nesedí:

| Spôsob | Beží kde | Zachytí `oppref` | Checkout | Prežije publikovanie inej témy | |
|---|---|---|---|---|---|
| snippet v téme | reálna stránka | áno, natívne SDK | nie | **nie** | používame |
| custom pixel | LAX sandbox (iframe) | nie | áno | áno | používame |
| app web pixel extension | STRICT sandbox (worker) | nie | áno | áno | nepoužiteľné — worker nemá `document`, SDK sa nespustí |
| app embed block (theme app extension) | reálna stránka | áno | nie | zapína sa per téma | vyžaduje z custom appky spraviť CLI appku s extension |
| ScriptTag API | reálna stránka | áno | nie | áno | mŕtve — od 1. 10. 2026 sa nedá vytvoriť, od 1. 3. 2027 prestane bežať |
| Conversions API | server | áno (pošleme mu ho my) | áno | áno | ďalší krok, viď nižšie |

Ku dvom veciam, ktoré nie sú zrejmé:

- **Sandbox nie je nepriehľadný pre nás, ale pre SDK.** Custom pixel dostáva
  v každom evente `context.window.location` — snapshot vrchného rámca — a cez
  `browser.cookie` / `browser.localStorage` píše do first-party úložiska
  obchodu. `oppref` si teda prečítať vieme; podstrčiť ho SDK-čku nie, lebo to si
  ho číta zo svojho `window.location` v sandboxe. Použiteľný je preto len na
  server-side odoslanie (Conversions API).
- **Vybrané appky sandbox obchádzajú.** Na CZ bežia dnes 3 app pixely v
  `STRICT` kontexte, 2 v `OPEN` (teda priamo v stránke — Google & YouTube) a
  kontajner na custom pixely v `LAX`. `OPEN` prideľuje Shopify sám, my sa k nemu
  nedostaneme; preto tú istú prácu robí snippet v téme.

## Inštalácia

```
node scripts/openai-pixel.mjs cz                      # dry run — vypíše, čo by spravil
node scripts/openai-pixel.mjs cz --apply              # zapíše snippet do živej témy
node scripts/openai-pixel.mjs cz --all-themes --apply # do všetkých tém obchodu
node scripts/openai-pixel.mjs cz --check              # je snippet v živej téme?
node scripts/openai-pixel.mjs cz --print-pixel        # JS na vloženie do admina
node scripts/openai-pixel.mjs cz --remove --apply     # odinštaluje snippet z témy
```

Pixel ID sa berie z `OPENAI_PIXEL_ID_CZ` (alebo `--pixel-id <id>`); v repe
nikde nie je, v súboroch je zástupný `__OPENAI_PIXEL_ID__`. ID sa vyrába
v Ads Manageri na karte *Conversions*.

Skript zapíše do témy `snippets/openai-pixel.liquid` a do `layout/theme.liquid`
pridá `{%- render 'openai-pixel' -%}` hneď pod `<meta name="viewport">`, teda čo
najvyššie v `<head>` (OpenAI to odporúča, aby sa nestratili skoré konverzie).
Bez `--apply` sa nezapisuje nič. `--theme <id>` cieli na inú tému, než je živá —
hodí sa na vyskúšanie na náhľade.

## Publikovanie novej témy meranie vypne

Snippet žije v téme, takže pri publikovaní inej témy z nej zmizne — a v Ads
Manageri sa to prejaví len tichým poklesom konverzií. Preto:

- `--all-themes` zapíše snippet do **všetkých** tém obchodu, nielen do živej, aby
  prežil aj rollback na staršiu tému,
- `--check` overí, či je snippet v téme a či ho `<head>` naozaj volá; končí
  s návratovým kódom 1, keď niečo chýba, takže sa dá pustiť aj z cronu.

Custom pixel touto krehkosťou netrpí — je viazaný na obchod, nie na tému.

## Custom pixel do admina

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
treba API kľúč z Ads Manageru; kým nie je, pixel beží sám. Po jeho nasadení sa
snippet v téme dá zredukovať alebo úplne zrušiť — `oppref` by potom zbieral
custom pixel z `context.window.location` a posielal ho server-side.

Ostatné backendy (RO/PL/HU) kampane nemajú a pixel na nich nie je. Skript ich
vie obslúžiť tiež — stačí kľúč obchodu a jeho `OPENAI_PIXEL_ID_<KEY>`.
