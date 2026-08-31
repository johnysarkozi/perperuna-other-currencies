# Jazykové galérie produktov

Produktové fotky nesú text (benefity, recenzie, návod), takže každý jazyk
potrebuje vlastnú sadu. Rieši to metafield `custom.<locale>_images` typu
`list.file_reference` na produkte.

## Ako to číta téma

`snippets/product-gallery.liquid` odvodí kľúč z locale:

```liquid
assign override_key = locale_iso | append: '_images'
assign gallery_override_media = product.metafields.custom[override_key].value
```

Ak metafield existuje a nie je prázdny, galéria sa iteruje **priamo z neho**
(`gallery_media_count = gallery_override_media.size`). Z toho plynie:

- zoznam musí byť v **rovnakom poradí** ako `product.media`,
- **kratší zoznam = menej fotiek v galérii** — pozícia sa dá čisto vynechať,
- nový jazyk nepotrebuje zásah do témy, stačí metafield.

Locale kódy sú ISO: slovinčina je `sl` (nie `si`), chorvátčina `hr` (nie `cr`).

Eurový backend má locale `sk` (primárny), `bg`, `de`, `en`, `es`, `fr`, `hr`,
`it`, `nl`, `sl`. Iba pre ne má metafieldová galéria zmysel.

**RO a HU sem nepatria** — sú to samostatné obchody s vlastnou menou, kde je
rumunčina a maďarčina primárnym jazykom. Tam storefront ukazuje priamo médiá
produktu, takže preklad znamená vymeniť médiá, nie pridať metafield. Figma
sekcie `KOCKY RUMUNSKO/HU` a `CAJ RUMUNSKO/HU` sú pripravené, ale plán z nich
sa na eurový backend nesmie použiť.

**Holandčina nemá vo Figme sekciu** — `nl` je publikovaný locale bez vlastných
galérií, takže na ňom vidno slovenské obrázky.

## Odkiaľ sa berú obrázky

Zdrojom je Figma, súbor `perperuna`, plátno *Produktova galeria jazykove
mutacie*. Framy sú pomenované strojovo čitateľne:

```
PG PERPERUNA / KOCKY / SI / UPLIFT / 5
               typ     jazyk produkt  ↑ počítadlo z duplikovania, NIE pozícia
```

Číslo na konci **nie je pozícia v galérii** — vzniklo duplikovaním sekcie
(SK 1–4, DE/BG/PL/SI 5–8, EN 9–12, FR 13–16, IT 21–24). Mapovať sa podľa neho
nedá.

Spoľahlivý kľúč je **geometria**: každá jazyková sekcia je kópia slovenskej,
takže framy sedia na rovnakých relatívnych súradniciach v rámci sekcie. Tak sa
páruje SK fram → fram v cieľovom jazyku.

## Ako sa zistí, ktorý fram patrí na ktorú pozíciu

Názvy súborov v Shopify sú nepoužiteľné — tá istá pozícia je na SK `3.png`
a na DE `5.png`. Používa sa preto perceptuálny hash (16×16 dHash) renderu
framu proti médiu produktu.

Rozhoduje **odstup od druhého kandidáta**, nie absolútna vzdialenosť: správny
fram býva ďaleko (iná revízia grafiky), ale s veľkým náskokom. Prah je
`odstup ≥ 18`. Keď odstup chýba, rozhodujú dve poistky:

- **Sú kandidáti vôbec rozlíšiteľní?** Zostava piatich čajov je vo Figme
  v každom riadku znova a všetky kópie sú totožné — vtedy je jedno, ktorú
  vezmeme, a nerozhodný výsledok je neškodný.
- **Patrí kandidát k tomuto produktu?** Grafika „Spremenite svojo kopel" má
  naprieč čajmi rovnaký layout a líši sa len sáčkom. Kandidát z tej istej
  skupiny (a do vzdialenosti 60) rozhodne.

Hodnotia sa **obe strany**: slovenské médium proti slovenským framom
a nemecký súbor proti nemeckým. Slovenská strana hovorí, čo stránka ukazuje;
nemecká pomôže tam, kde je slovenské médium starší export, ktorý sa už do
Figmy nepreniesol. Nemecká sekcia má jeden fram posunutý oproti slovenskej,
takže nemecká geometria sa najprv prevádza na slovenskú.

Overené proti šiestim ručne pripraveným slovinským galériám kociek: 6/6.

## Čo sa stane s pozíciou bez prekladu

- **bez textu** → ponechá sa slovenské médium (fotka je jazykovo neutrálna).
  Rozpozná sa podľa sekcie `Doplnujuce` — hero zábery, misky, aranžmány. Nedá
  sa na to použiť pravidlo „DE sa líši od SK": napríklad The Ritual set má
  v nemčine tie isté univerzálne fotky nahraté ako samostatné kópie.
- **to isté médium už preložené na inom produkte** → prevezme sa hotový súbor,
  nerenderuje sa znova.
- **s textom, preklad chýba** → pozícia sa z galérie **vynechá**. Radšej menej
  fotiek než fotka s cudzím textom.

Grafiky, ktoré existujú len v `sk/de/pl/bg` a v ostatných jazykoch chýbajú:
`OPRAVA SKIBIDI` („Premeň sprchovú rutinu") a `KOCKY/*/OPRAVA/RECENZIE`
(prepracovaná verzia recenzií bez nadpisu).

## Postup

```
node scripts/figma-scan.mjs "<figma url>" --depth=2   # obhliadka štruktúry
node scripts/gallery-from-figma.mjs plan/sl-figma.json            # dry run
node scripts/gallery-from-figma.mjs plan/sl-figma.json --apply
```

Zdroj obrázkov je voliteľný:

- `--source=figma` (default) — render cez REST API, potrebuje `FIGMA_TOKEN`
  (personal access token, scope `file_read`, iba z env premennej).
- `--source=<dir>` — lokálny export z Figmy. Figma pri exporte mení lomky
  v názve framu na priečinky, takže strom sedí s `figmaName` v pláne
  a netreba nič prečíslovávať.

### Pozor na limit Figma API

Limit renderovacieho endpointu `/v1/images` sa neviaže na plán, ale na **typ
sedadla** účtu, ktorému patrí token:

| Sedadlo | Limit na `/v1/images` |
|---------|-----------------------|
| View / Collab | 20 requestov **za mesiac** |
| Dev / Full | 15 requestov **za minútu** (plán Professional) |

Hlavička `x-figma-rate-limit-type: low` v odpovedi znamená View/Collab sedadlo.
Kúpa vyššieho plánu s tým nespraví nič — viewer na Organization má rovnaké
mesačné limity ako viewer na Starteri. Musí sa zmeniť sedadlo.

Použi preto token účtu s Dev/Full sedadlom. Do jedného requestu sa zmestí
viac `ids` naraz (skript posiela po desiatich), takže 44 framov sú 3 requesty
a všetkých 8 jazykov zhruba 25.

Čítanie štruktúry (`/v1/files`) má limit vlastný a ostáva funkčné aj po
vyčerpaní renderovacieho.

Keď token s Dev/Full sedadlom nie je po ruke, použi `--source=<dir>` s ručným
exportom sekcie z Figmy — výsledok je rovnaký.
