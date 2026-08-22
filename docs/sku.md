# Kľúč k SKU kódom

> Odvodené spätne z 57 SKU, ktoré reálne existujú v obchodoch (stav
> 2026-08-22). Nie je to prevzatý firemný štandard — je to popis toho, čo
> v dátach je. Ak sa niekde moje čítanie rozchádza s tým, ako to bolo myslené,
> uprav tento dokument, on je odteraz referencia.

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
| `BUND` | V `PP-BATE-BUND-031` = kompletná kolekcia v rámci kategórie |

## Číslo

Trojmiestne poradové číslo produktu, priraďované vzostupne naprieč celým
katalógom (`001` až `034`), **nie** samostatne v rámci kategórie. Preto
`PP-CUBE-UPLI-001` a `PP-BATE-CHOC-030` nesúvisia inak než poradím vzniku.

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

Toto sú reálne odchýlky od pravidiel vyššie. Nie sú kritické, ale ak sa má
konvencia dodržiavať, treba ich buď opraviť, alebo pravidlo upraviť.

1. **`PP-ACCS-BRUS-32`** má dvojmiestne číslo namiesto trojmiestneho.
   Malo by byť `032` — lenže to koliduje s `PP-BATE-BUND-032`.
2. **Čísla nie sú unikátne.** Rovnaké číslo nesú:
   - `020` → `PP-CUBE-LOVE-020` aj `PP-NUBE-NEDO-020`
   - `021` → `PP-RSET-LOVE-021` aj `PP-NUBE-NEDO-021`
   - `025` → `PP-ESET-RITU-025` aj `PP-NUBE-LOVE-025`

   Ak má číslo identifikovať produkt, malo by byť jedinečné. Zatiaľ je
   jedinečný až celý SKU.
3. **Dva kódy pre ten istý rituál** — `RITL` (`PP-RSET-RITL-010`) aj `RITU`
   (`PP-ESET-RITU-025`) znamenajú The Ritual.
4. **`PP-NUBE-NEDO-021` existuje len na CZ**, na SK ani inde nie je.

## Pravidlá pre nové SKU

1. Prefix je vždy `PP-`.
2. Kategória zo zoznamu vyššie; nová kategória len ak naozaj nejde zaradiť.
3. Variant = prvé 4 písmená názvu vône/rituálu, alebo skratka predmetu.
4. Číslo = najvyššie doteraz použité **+1**, trojmiestne. Aktuálne najvyššie
   je `034`, takže ďalší nový produkt dostane `035`.
5. Balík dostane `BUND` a čísla svojich súčastí namiesto variantu.
6. Ten istý fyzický produkt v inom režime predaja → prípona, nie nové číslo.
