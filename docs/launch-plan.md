# Plán spustenia RO / PL / HU

Stav k 2026-08-22. Zdroj: `node scripts/audit-launch.mjs`, plné dáta
v [`launch-audit.json`](launch-audit.json).

## Zhrnutie

**Preklady sú v poriadku.** Prekontroloval som každý zákazníkovi viditeľný text
— názvy a popisy produktov, kolekcie, stránky, menu, dopravné sadzby, právne
dokumenty a obsah témy — a slovenčina nikde nepresakuje do RO/PL/HU. Ceny sú
reálne prepočítané do miestnych mien vrátane psychologických koncoviek
(RON 78,90 / PLN 64,90 / HUF 5 390), nie skopírované čísla.

**Čo bráni spusteniu, je logistika a platby, nie obsah.** Doprava na všetkých
troch obchodoch je nedotknutá kópia zo SK: zóna „Domestic" obsahuje **len SK**
a všetky sadzby sú **v eurách**. Zóna „International" nezahŕňa RO ani HU.

| | RO | PL | HU |
|---|---|---|---|
| Zákazník prejde checkoutom | **nie** — krajina mimo zón | áno, ale za 17 € „international" | **nie** — krajina mimo zón |
| Sadzby v mene obchodu | nie (EUR) | nie (EUR) | nie (EUR) |
| Platobná brána | nezistená | nezistená | nezistená |
| Vlastná doména | ✅ perperuna.ro | ✅ www.perperuna.pl | **nie** — stále myshopify |
| Obrázky produktov | ✅ | ✅ | **nie — 0 obrázkov** |

CZ pre porovnanie funguje správne: zóna „Czechia", sadzby v CZK, Packeta +
kuriér, Apple/Google Pay aktívne. Je to použiteľná predloha pre ostatné tri.

---

## Blockery — bez týchto sa spustiť nedá

### 1. Doprava (všetky tri)

Aktuálny stav na RO/PL/HU je identický:

```
zóna "Domestic":      SK              → Štandardná 3,99 EUR, Expresná 6,99 EUR
zóna "International": 28 krajín       → International 16–17 EUR
                      (obsahuje PL a CZ, neobsahuje RO ani HU)
```

Pre každý obchod:

1. Vytvoriť domácu zónu pre cieľovú krajinu (RO / PL / HU).
2. Sadzby zadať **v mene obchodu** — RON / PLN / HUF. Sadzba v EUR na
   nie-eurovom obchode je zdroj chýb v prepočte aj v účtovníctve.
3. Doplniť lokálneho dopravcu a odberné miesta, ako to má CZ s Packetou —
   pre PL a HU je Packeta/Zásilkovna dostupná, pre RO overiť pokrytie
   (alternatívy: Sameday easybox, Cargus).
4. Zvážiť prah pre dopravu zadarmo v miestnej mene.
5. Zo zóny „International" vyňať krajinu, ktorá dostala vlastnú domácu zónu,
   nech nevznikne dvojaká sadzba.

### 2. Platobná brána (všetky tri)

Žiadny z troch obchodov nehlási podporu digitálnych peňaženiek, kým CZ hlási
Apple Pay aj Google Pay. To takmer isto znamená, že platobná brána nie je
aktivovaná. Admin API neumožňuje vyčítať zoznam brán priamo — over ručne
v **Settings → Payments**:

- Shopify Payments je dostupné v RO, PL aj HU — over, či je krajina účtu
  a bankový účet v správnej mene.
- Doplniť lokálne metódy, na ktoré sú zákazníci zvyknutí: **PL** BLIK a
  Przelewy24 (bez BLIK-u je konverzia v Poľsku výrazne nižšia), **RO** dobierka
  je stále bežná, **HU** prevod a dobierka.
- Zapnúť Apple/Google Pay.

### 3. HU: chýbajúce obrázky produktov

**Všetkých 28 aktívnych produktov na HU nemá ani jeden obrázok** (`mediaCount`
je 0). Obchod je v tomto stave nepredajný. Obrázky treba nahrať — dajú sa
prebrať z CZ/RO/PL, kde sú kompletné.

### 4. HU: doména

Market má web presence `perperuna.hu`, ale `primaryDomain` obchodu je stále
`perperuna-hu.myshopify.com`. Doménu treba dokončiť v **Settings → Domains**
(pridať, overiť DNS, nastaviť ako primárnu) a počkať na vydanie SSL.

---

## Pred spustením ešte doriešiť

- **Váhy na RO** — všetkých 27 aktívnych produktov má váhu 0 kg, kým CZ má
  70 g. Akonáhle bude sadzba závislá od hmotnosti, prepočet zlyhá. Na PL sa to
  týka 3 produktov (sety), HU je v poriadku.
- **DPH / OSS** — obchody sú vedené na SK adrese a dane sú v cene. Pri predaji
  do RO/PL/HU treba mať vyriešenú registráciu v OSS a v Shopify nastavené
  správne sadzby pre každú krajinu. Toto som z API neoveroval — je to daňové
  rozhodnutie, nie konfiguračné.
- **Šablóna `product.sety-a-doypacky.json`** (RO/PL/HU) je ručný jazykový
  prepínač `{% if lang == "de" %}…{% elsif lang == "bg" %}…{% else %}` a vetva
  `else` obsahuje **slovenčinu**. Momentálne ju nepoužíva žiadny aktívny
  produkt, takže zákazník ju nevidí — ale v okamihu, keď na ňu nejaký produkt
  prepneš, začne sa zobrazovať slovenský text. Buď doplniť vetvy pre ro/pl/hu,
  alebo prepísať fallback na miestny jazyk.
- **Vypredané produkty** — PL má 2 aktívne produkty vypredané a bez povolenia
  objednávky na sklad, CZ jeden. Pred spustením buď doskladniť, alebo stiahnuť
  z ponuky.
- **Produkty bez popisu** — na každom obchode jeden (`nedokonale-*` /
  `cuburi-imperfecte` / `tokeletlen-*`). Popis týchto produktov žije v šablóne
  `product.nedokonale-kocky.json`, ktorá **je** správne preložená, takže
  zákazník text vidí. Nie je to chyba, len upozornenie auditu.
- **Prázdne kolekcie a nepublikovaná stránka Kontakt** (CZ) — kozmetika,
  ale pred spustením kampane to stojí za prejdenie.

---

## Poradie krokov

Pre každý obchod zvlášť, RO a PL sú bližšie k cieľu než HU.

1. **Platby** — bez brány nemá zmysel riešiť nič ďalšie.
2. **Doprava** — domáca zóna, sadzby v miestnej mene, lokálny dopravca.
3. **HU: obrázky + doména** — dva veľké samostatné bloky práce.
4. **Váhy** na RO (a 3 produkty na PL).
5. **Testovacia objednávka** cez Shopify Payments test mode: prejsť celý tok od
   košíka po potvrdzovací e-mail a skontrolovať, že checkout, potvrdzovací
   e-mail aj faktúra sú v miestnom jazyku a mene. Toto je jediný krok, ktorý
   spoľahlivo odhalí problémy v checkoute a v notifikačných e-mailoch — ich
   obsah som cez Admin API overiť nevedel.
6. Až potom marketing a sales kanály (CZ má navyše FB/IG, Google/YouTube,
   Inbox; RO/PL/HU majú len Online Store + POS).

## Overenie po zmenách

```
node scripts/audit-launch.mjs ro pl hu
```

Cieľ je nula 🔴 riadkov.
