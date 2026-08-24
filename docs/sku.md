# Kľúč k SKU kódom

> Odvodené z 57 SKU, ktoré reálne existujú v obchodoch (stav 2026-08-22),
> a upresnené podľa toho, ako bola konvencia myslená. Tento dokument je
> referencia — ak sa niečo zmení, uprav ho.

## Základný tvar

```
PP - KATEGÓRIA - VARIANT - ČÍSLO
     4 znaky     4 znaky   3 číslice

PP-CUBE-BALA-003
│   │    │    └── poradové číslo produktu
│   │    └─────── variant (vôňa / farba / názov rituálu)
│   └──────────── kategória produktu
└──────────────── prefix značky (Perperuna), rovnaký vždy
```

## Kategórie

| Kód | Význam | Príklad |
|-----|--------|---------|
| `CUBE` | Sprchová aromatická kocka | `PP-CUBE-CALM-004` |
| `NUBE` | Nedokonalá kocka (2. akosť) | `PP-NUBE-CALM-018` |
| `BALL` | Sprchové guľôčky (5 ks) | `PP-BALL-REFR-005` |
| `BATE` | Čaj do kúpeľa (**BA**th **TE**a) | `PP-BATE-HERB-028` |
| `ACCS` | Príslušenstvo | `PP-ACCS-SPOU-011` |
| `ESET` | Essential set (s bavlneným vrecúškom) | `PP-ESET-LOVE-022` |
| `RSET` | Ritual set (kompletný, s kamennou miskou) | `PP-RSET-GDNT-024` |
| `BUND` | Balík zložený z iných produktov | `PP-BUND-010-009-008` |

## Varianty

**Vône a rituály** — prvé 4 písmená názvu:

| Kód | Význam | | Kód | Význam |
|-----|--------|-|-----|--------|
| `BALA` | Balance | | `CHOC` | Mount Chocolate |
| `BREA` | Breathe | | `DREA` | Dream Valley |
| `CALM` | Calm | | `HERB` | Herbal Spring |
| `UPLI` | Uplift | | `NORD` | Nordic Forest |
| `LOVE` | Love | | `SECR` | Secret Garden |
| `REFR` | Refresh | | `RSHI` | Rise & Shine |
| `GING` | Gingerbread | | `SWDR` | Sweet Dreams |
| `GDNT` | Good Night | | `RITL` / `RITU` | The Ritual |

**Príslušenstvo** — skratka predmetu, pri miske aj farba:

| Kód | Význam |
|-----|--------|
| `BWLW` | Bowl White — kamenná miska biela |
| `BWLB` | Bowl Black — čierna |
| `BWLP` | Bowl Pink — ružová |
| `SPOU` | Pouch — bavlnené vrecúško |
| `BRUS` | Brush — kefa na suché kefovanie |

**Zvláštne:**

| Kód | Význam |
|-----|--------|
| `NEDO` | Balenie nedokonalých kociek (mix vôní, nie konkrétna vôňa) |
| `BUND` | Kompletná kolekcia v rámci kategórie — `PP-BATE-BUND-031` (všetkých 5 čajov), `PP-CUBE-BUND-034` (10 kociek, 2× každá vôňa), `PP-RSET-BUND-025` (5 kociek + miska). Nezamieňať s kategóriou `BUND`, ktorá skladá balík z rôznych kategórií. |

## Číslo

Trojmiestne číslo, ktoré **odlišuje produkty v rámci tej istej kategórie**.
Musí byť jedinečné iba tam — naprieč kategóriami sa pokojne opakuje a nič to
neznamená. `PP-CUBE-LOVE-020` a `PP-NUBE-NEDO-020` sú dva úplne odlišné
produkty, nesúvisia.

Overené na dátach: v každej kategórii je každé číslo použité raz. Jediná
výnimka je `011` v `ACCS`, ktoré nesú tri SKU — ale to je ten istý produkt
s príponami (`SPOU-011`, `-011-FREE`, `-011-SET`), teda zámer, nie kolízia.

Historicky boli čísla prideľované vzostupne podľa poradia vzniku, takže naprieč
katalógom idú zhruba od `001` po `034`. To je ale len pozostatok — pravidlo
je „jedinečné v kategórii", nie „jedinečné všade".

## Balíky (BUND)

Namiesto variantu majú **čísla produktov, ktoré obsahujú**, oddelené pomlčkami:

```
PP-BUND-010-009-008
        │   │   └── 008 = Rise & Shine
        │   └────── 009 = Sweet Dreams
        └────────── 010 = The Ritual
```

Poradie čísel zodpovedá poradiu v názve produktu.

## Prípony

| Prípona | Význam | Príklad |
|---------|--------|---------|
| `-FREE` | Darčekový variant, cena 0 | `PP-ACCS-SPOU-011-FREE` |
| `-SET` | Variant priložený k inému setu | `PP-ACCS-SPOU-011-SET` |

Prípona sa vzťahuje na ten istý fyzický produkt — `011`, `011-FREE` aj
`011-SET` je to isté vrecúško, len predávané za iných podmienok. **Sklad sa
im ale vedie samostatne.**

## SKU mimo konvencie

| SKU | Čo to je |
|-----|----------|
| `FEE-FAST` | Expresné spracovanie objednávky |
| `FEE-GIFT` | Zabaliť ako darček |
| `FEE-PAPER` | Papierové balenie |
| `FEE-SAFE` | Bezpečné doručenie |
| `FEE-SMALL` | Manipulačný poplatok pri malej objednávke |
| `BUNDLE-1/2/3` | Staršie cenové hladiny „Výhodná sada kociek" |

`FEE-*` nie sú tovar, ale doplnkové služby — v katalógu sa objavujú ako
produkty, lebo tak sú vedené v Shopify. Sklad sa im nesleduje.

## Nezrovnalosti v súčasných dátach

1. **`PP-ACCS-BRUS-32`** má dvojmiestne číslo namiesto trojmiestneho. Malo by
   byť `PP-ACCS-BRUS-032` — a keďže sa jedinečnosť rieši len v rámci kategórie,
   `032` je v `ACCS` voľné (to druhé `032` je v `BATE`, čo nevadí). Oprava je
   teda bezpečná.
2. **Dva kódy pre ten istý rituál** — `RITL` (`PP-RSET-RITL-010`) aj `RITU`
   (`PP-ESET-RITU-025`) znamenajú The Ritual.
3. **`PP-NUBE-NEDO-021` existuje len na CZ**, na SK ani inde nie je. To nie je
   chyba pomenovania, ale diera v katalógu.

## Pravidlá pre nové SKU

1. Prefix je vždy `PP-`.
2. Kategória zo zoznamu vyššie; nová kategória len ak sa produkt naozaj nedá
   zaradiť.
3. Variant = prvé 4 písmená názvu vône/rituálu, alebo skratka predmetu.
4. Číslo = akékoľvek trojmiestne, ktoré **v tej kategórii ešte nie je**.
   Najjednoduchšie najvyššie v danej kategórii + 1:

   | Kategória | Najvyššie použité | Ďalšie voľné |
   |-----------|-------------------|--------------|
   | `CUBE` | 034 | **035** |
   | `NUBE` | 035 | **036** |
   | `BALL` | 007 | **008** |
   | `BATE` | 032 | **033** |
   | `ACCS` | 032 | **033** |
   | `ESET` | 025 | **026** |
   | `RSET` | 025 | **026** |

5. Balík dostane `BUND` a čísla svojich súčastí namiesto variantu.
6. Ten istý fyzický produkt v inom režime predaja → prípona (`-FREE`, `-SET`),
   nie nové číslo.
