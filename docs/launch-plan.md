# Plán spustenia RO / PL / HU

Stav k 2026-09-01. Zdroj: `node scripts/audit-launch.mjs`, plné dáta
v [`launch-audit.json`](launch-audit.json). Pôvodná verzia tohto plánu bola
k 2026-08-22 — odvtedy sa doprava, platby (čiastočne), obrázky na HU aj
portfólio na PL reálne dorobili. Nechávam pôvodné sekcie nižšie ako referenciu
(ceny dopravcov, odporúčania), ale tabuľka a blockery odrážajú dnešný stav.

## Zhrnutie

**Preklady sú v poriadku.** Prekontroloval som každý zákazníkovi viditeľný text
— názvy a popisy produktov, kolekcie, stránky, menu, dopravné sadzby, právne
dokumenty a obsah témy — a slovenčina nikde nepresakuje do RO/PL/HU. Ceny sú
reálne prepočítané do miestnych mien vrátane psychologických koncoviek.

**Doprava a obrázky sú hotové na všetkých troch.** Každý obchod má vlastnú
domácu zónu s lokálnym dopravcom v miestnej mene (PL: Kurier DPD 15,90 zł /
InPost Paczkomat 13,90 zł; RO: FAN Courier 19 RON / Packeta Z-Box 16 RON /
Sameday easybox 15 RON; HU: Express One 1490 Ft / FoxPost 990 Ft) — presne
podľa odporúčania nižšie. HU obrázky produktov sú doplnené (predtým 0/28).

**Jediný skutočný blocker pre PL je teraz heslo na obchode**, nič v katalógu,
doprave ani platbách. RO a HU majú navyše ešte vlastné veci — pozri tabuľku.

| | RO | PL | HU |
|---|---|---|---|
| Obchod chránený heslom | 🔴 áno | 🔴 áno | 🔴 áno |
| Doprava v miestnej mene | ✅ | ✅ | ✅ |
| Apple/Google Pay | 🔴 nezistené | ✅ aktívne | 🔴 nezistené |
| Vlastná doména | ✅ perperuna.ro | ✅ www.perperuna.pl | 🔴 stále myshopify |
| Obrázky produktov | ✅ | ✅ | ✅ (doplnené) |
| Katalóg zosúladený so SK | ✅ | ✅ | neoverované teraz |

CZ pre porovnanie funguje správne: zóna „Czechia", sadzby v CZK, Packeta +
kuriér, Apple/Google Pay aktívne. Je to použiteľná predloha pre ostatné tri.

### PL: heslo na obchode je teraz jediné, čo bráni spusteniu

`www.perperuna.pl/` presmerúva na `/password` — nezávisle od toho, aké
pripravené je všetko ostatné, žiadny zákazník sa cez túto stránku nedostane.
Toto je nastavenie **Online Store → Preferences → Password protection**, cez
Admin API sa nedá prečítať ani zmeniť — treba to vypnúť ručne. Skontrolované
aj RO a HU: majú ho zapnuté tiež. `audit-launch.mjs` to od teraz kontroluje
priamo (jeden nezautentifikovaný `fetch` na domovskú stránku), takže sa to už
nebude dať prehliadnuť.

---

## Blockery — bez týchto sa spustiť nedá

### 0. Heslo na obchode (RO, PL, HU)

Pozri zhrnutie vyššie. Vypnúť v **Online Store → Preferences** na každom z
troch obchodov. Toto je jediná vec, ktorú `audit-launch.mjs` overuje naživo
(zvyšok číta z Admin API) — spustiť znova po vypnutí, aby sa potvrdilo, že
zmizlo z výstupu.

### 1. Doprava — ✅ vyriešené (RO, PL, HU)

Každý obchod má teraz vlastnú domácu zónu v miestnej mene s rovnakým
dopravcom, aký odporúča sekcia nižšie (PL: DPD/InPost Paczkomat, RO: FAN
Courier/Packeta Z-Box/Sameday easybox, HU: Express One/FoxPost). Pôvodný stav
(nedotknutá kópia SK zóny v EUR) je zdokumentovaný nižšie len ako historická
referencia — neplatí už.

<details>
<summary>Pôvodný nález (2026-08-22, už neaktuálny)</summary>

```
zóna "Domestic":      SK              → Štandardná 3,99 EUR, Expresná 6,99 EUR
zóna "International": 28 krajín       → International 16–17 EUR
                      (obsahuje PL a CZ, neobsahuje RO ani HU)
```

</details>

#### Výber dopravcov a ceny (podľa Packeta ceníka z 22.8.2026 + benchmark Notino v danej krajine)

Packeta fakturuje vždy v EUR bez ohľadu na krajinu doručenia — sumy nižšie sú
skutočný náklad na zásielku do 1 kg (Perperuna produkty sú ľahké, do 5 kg sa
cena takmer nemení), prepočet do miestnej meny je len orientačný pre porovnanie
s predajnou cenou.

| Krajina | Kuriér | Cost (kuriér) | Box/výdajné miesto | Cost (box) | Notino v tej krajine |
|---|---|---|---|---|---|
| PL | **DPD** | 3,90 € (~17 zł) | **InPost Paczkomat** | 3,80 € (~16 zł) | DPD 12,90 zł / Paczkomat 9,90 zł |
| RO | **FAN Courier** | 4,09 € (~20 RON) | **Packeta Z-Box** | ~2,99 € (~15 RON) | FAN Courier 14 lei / Packeta 10–13 lei |
| HU | **Express One** | 4,31 € (~1 700 Ft) | **FoxPost** | ~3,14 € (~1 240 Ft) | Express One 990 Ft / FoxPost 850 Ft |

Notino má vyjednané veľkoobjemové sadzby nižšie než tento cenník — jeho ceny sú
orientačný trhový benchmark, nie cieľ, ktorý treba nákladovo dorovnať.

Odporúčaná predajná cena (bez ohľadu na maržu, len trhová primeranosť):

- **PL**: Paczkomat 14,90 zł, DPD kuriér 17,90 zł, doprava zdarma nad 150 zł.
- **RO**: Z-Box 14,90 RON, FAN Courier 19,90 RON, doprava zdarma nad 200 RON.
  RO trh očakáva dobierku (ramburs) — všetky tri RO možnosti (FAN Courier,
  Cargus, Z-Box) ju v Packeta ceníku podporujú.
- **HU**: FoxPost 990 Ft, Express One 1 490 Ft, doprava zdarma nad 15 000 Ft.

Alternatíva pre RO box: **Sameday easybox** (~4,18 €, ~21 RON) — drahšia než
Z-Box o cca 40 %, ale „easybox" je v Rumunsku extrémne rozpoznaná značka
(podobne ako Paczkomat v PL). Stojí za A/B test, ak Z-Box konvertuje slabo.

Pomenovania metód v checkoute musia byť lokálne rozpoznateľné značky
(„FoxPost", „InPost Paczkomat", „FAN Courier"), nie generické „Kuriér" —
zákazník v danej krajine tú značku pozná a dôveruje jej.

Fulfillment: overiť, či je na tieto tri obchody nainštalovaná Packeta appka
v Shopify na generovanie štítkov, alebo sa štítky riešia manuálne cez Packeta
klient zónu — z Admin API to nebolo vidieť.

### 2. Platobná brána — PL hotové, RO a HU nie

**PL** hlási Apple Pay aj Google Pay aktívne — brána je zapnutá. **RO a HU
stále nehlásia žiadnu digitálnu peňaženku** — pravdepodobne platobná brána
ešte nie je aktivovaná. Admin API neumožňuje vyčítať zoznam brán priamo — over
ručne v **Settings → Payments**:

- Shopify Payments je dostupné v RO aj HU — over, či je krajina účtu
  a bankový účet v správnej mene.
- Doplniť lokálne metódy, na ktoré sú zákazníci zvyknutí: **PL** BLIK a
  Przelewy24 (bez BLIK-u je konverzia v Poľsku výrazne nižšia — over, či sú
  zapnuté aj keď Apple/Google Pay už fungujú, keďže Admin API BLIK/Przelewy24
  nevidí), **RO** dobierka je stále bežná, **HU** prevod a dobierka.

### 3. HU: obrázky produktov — ✅ vyriešené

Predtým všetkých 28 aktívnych produktov bez obrázka (`mediaCount` 0), teraz
majú obrázky doplnené.

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
- **Mena v košíkovom JS — ✅ vyriešené na PL, RO aj HU.** `sections/main-cart.liquid`
  vykreslí ceny Liquidom správne, ale skript sekcie ich hneď po načítaní
  prepočíta a prepíše vlastným formátovačom `mon()`, ktorý mal menu zapísanú
  natvrdo zo SK témy — zákazník tak videl € namiesto miestnej meny v súhrne
  košíka aj na progress baroch. Opravené `mon()` si teraz berie formát zo
  `shop.money_format` na všetkých troch (`scripts/fix-cart-money-format.mjs`).
  CZ má vlastnú variantu `mon()`, ktorá zaokrúhľuje na celé Kč, no
  `shop.money_format` na CZ je s desatinnými miestami (bez desatinných je len
  `money_with_currency_format`). Oprava by tam teda pridala haliere — pred
  spustením skriptu na CZ najprv zjednotiť formát v nastaveniach obchodu.
- **Vypredané produkty** — na PL má „Kompletná kolekcia" (The Ritual/Sweet
  Dreams/Rise & Shine) a „Love" kocka nulový sklad s DENY politikou — presne
  ako ich SK náprotivky, nie chyba synchronizácie. Pred spustením buď
  doskladniť, alebo stiahnuť z ponuky (na oboch backendoch).
- **Prázdne kolekcie a nepublikovaná stránka Kontakt** (CZ) — kozmetika,
  ale pred spustením kampane to stojí za prejdenie.

---

## Poradie krokov

PL je najbližšie k cieľu, RO druhé, HU má navyše doménu.

1. **Vypnúť heslo na obchode** (RO, PL, HU) — bez toho je jedno, čo je
   pripravené inde, zákazník sa tam nedostane.
2. **Platby** — RO a HU ešte potrebujú aktivovať bránu (PL má Apple/Google Pay).
3. **HU: doména** — jediný zostávajúci veľký blok práce na HU.
4. **Váhy** na RO (a 3 produkty na PL) — neoverované od 22.8., overiť znova.
5. **Testovacia objednávka** cez Shopify Payments test mode: prejsť celý tok od
   košíka po potvrdzovací e-mail a skontrolovať, že checkout, potvrdzovací
   e-mail aj faktúra sú v miestnom jazyku a mene. Toto je jediný krok, ktorý
   spoľahlivo odhalí problémy v checkoute a v notifikačných e-mailoch — ich
   obsah sa cez Admin API overiť nedá. Skús to hneď po vypnutí hesla na PL,
   keďže tam už nič iné neblokuje.
6. Až potom marketing a sales kanály (CZ má navyše FB/IG, Google/YouTube,
   Inbox; RO/PL/HU majú len Online Store + POS).

## Overenie po zmenách

```
node scripts/audit-launch.mjs ro pl hu
```

Cieľ je nula 🔴 riadkov — od tejto verzie audit kontroluje aj heslo na
obchode naživo, nielen dáta z Admin API.
