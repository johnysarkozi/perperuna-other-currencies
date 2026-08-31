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
fram býva ďaleko (iná revízia grafiky), ale s veľkým náskokom. Kalibrované na
`odstup ≥ 18 a vzdialenosť ≤ 60`.

Či pozícia vôbec nesie text, sa berie z hotových nemeckých galérií: keď sa DE
súbor líši od SK média, obrázok text nesie.

## Čo sa stane s pozíciou bez prekladu

- **bez textu** → ponechá sa slovenské médium (fotka je jazykovo neutrálna),
- **s textom, preklad chýba** → pozícia sa z galérie **vynechá**. Radšej menej
  fotiek než fotka s cudzím textom.

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
