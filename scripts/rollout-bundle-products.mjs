#!/usr/bin/env node
/**
 * Rolls the three multipacks out from SK to every language and every backend.
 *
 *   node scripts/rollout-bundle-products.mjs --translate          # dry run
 *   node scripts/rollout-bundle-products.mjs --translate --apply  # SK locales
 *   node scripts/rollout-bundle-products.mjs --create             # dry run
 *   node scripts/rollout-bundle-products.mjs --create --apply     # CZ/RO/PL/HU
 *   node scripts/rollout-bundle-products.mjs --create --store=pl --apply
 *
 * --translate writes title, body, SEO title and SEO description for the nine
 * secondary locales of the SK store. --create builds the same three products
 * on the other four backends in their own language and currency, as drafts.
 *
 * Everything that already exists per backend — the how-to, FAQ and review
 * metaobjects, the scent benefit blocks, the collections, the ingredient
 * lists — is read live from that store's own Calm cube and Ritual set rather
 * than copied here. Only the new copy and the prices live in this file.
 */

import { graphql, paginate } from '../lib/shopify.mjs';

const SOURCE = 'sk';
const TARGETS = ['cz', 'ro', 'pl', 'hu'];
/** Backend key is not always the language code — the Czech store is `cz`/`cs`. */
const LOCALE_OF = { cz: 'cs', ro: 'ro', pl: 'pl', hu: 'hu' };
const START_QUANTITY = 500;

// ---- copy -----------------------------------------------------------------

/** Words shared by all three products. */
const T = {
  sk: {
    contents: 'Obsah', scents: 'Kompozícia vôní', mix: 'Mix',
    availability: 'Výber vôní sa líši podľa aktuálnej dostupnosti.',
    note1: 'Jedna sprchová kocka vydrží až 3 sprchy.',
    note2: 'Jedna kocka ti dopraje až 3 sprchy, z celého balenia máš približne 30 spŕch.',
    save: 'UŠETRI', promo: 'NEDOKONALÉ. <br> ROVNAKO VOŇAVÉ.',
    line: 'Uplift (Citrón-Mentol) · Breathe (Eukalyptus-Mentol) · Balance (Pomaranč-Bergamot) · Calm (Levanduľa-Mandarínka) · Refresh (Limetka-Citrónová tráva)',
  },
  cs: {
    contents: 'Obsah', scents: 'Kompozice vůní', mix: 'Mix',
    availability: 'Výběr vůní se liší podle aktuální dostupnosti.',
    note1: 'Jedna sprchová kostka vydrží až 3 sprchy.',
    note2: 'Jedna kostka vydrží až 3 sprchy, z celého balení máš přibližně 30 sprch.',
    save: 'UŠETŘI', promo: 'NEDOKONALÉ. <br> STEJNĚ VONNÉ.',
    line: 'Uplift (Citron-Mentol) · Breathe (Eukalyptus-Mentol) · Balance (Pomeranč-Bergamot) · Calm (Levandule-Mandarinka) · Refresh (Limetka-Citronová tráva)',
  },
  pl: {
    contents: 'Zawartość', scents: 'Kompozycja zapachów', mix: 'Mix',
    availability: 'Wybór zapachów zależy od aktualnej dostępności.',
    note1: 'Jedna kostka wystarcza nawet na 3 prysznice.',
    note2: 'Jedna kostka wystarcza nawet na 3 prysznice, z całego opakowania masz około 30 pryszniców.',
    save: 'OSZCZĘDŹ', promo: 'NIEDOSKONAŁE. <br> TAK SAMO PACHNĄCE.',
    line: 'Uplift (Cytryna-Mentol) · Breathe (Eukaliptus-Mentol) · Balance (Pomarańcza-Bergamotka) · Calm (Lawenda-Mandarynka) · Refresh (Limonka-Trawa cytrynowa)',
  },
  ro: {
    contents: 'Conținut', scents: 'Compoziția aromelor', mix: 'Mix',
    availability: 'Selecția aromelor variază în funcție de disponibilitate.',
    note1: 'Un cub pentru duș ajunge pentru până la 3 dușuri.',
    note2: 'Un cub ajunge pentru până la 3 dușuri, iar din tot pachetul ai aproximativ 30 de dușuri.',
    save: 'ECONOMISEȘTI', promo: 'IMPERFECTE. <br> LA FEL DE PARFUMATE.',
    line: 'Uplift (Lămâie-Mentol) · Breathe (Eucalipt-Mentol) · Balance (Portocală-Bergamotă) · Calm (Lavandă-Mandarină) · Refresh (Lime-Iarbă de lămâie)',
  },
  hu: {
    contents: 'Tartalom', scents: 'Illatkompozíció', mix: 'Mix',
    availability: 'Az illatok kiválasztása az aktuális készlettől függ.',
    note1: 'Egy zuhanykocka akár 3 zuhanyzásra is elég.',
    note2: 'Egy kocka akár 3 zuhanyzásra is elég, a teljes csomagból körülbelül 30 zuhanyzás lesz.',
    save: 'SPÓROLJ', promo: 'TÖKÉLETLEN. <br> UGYANOLYAN ILLATOS.',
    line: 'Uplift (Citrom-Mentol) · Breathe (Eukaliptusz-Mentol) · Balance (Narancs-Bergamott) · Calm (Levendula-Mandarin) · Refresh (Lime-Citromfű)',
  },
  de: {
    contents: 'Inhalt', scents: 'Duftkomposition', mix: 'Mix',
    availability: 'Die Duftauswahl richtet sich nach der aktuellen Verfügbarkeit.',
    note1: 'Ein Duschwürfel reicht für bis zu 3 Duschen.',
    note2: 'Ein Würfel reicht für bis zu 3 Duschen, aus der ganzen Packung werden rund 30 Duschen.',
    save: 'SPARE', promo: 'UNPERFEKT. <br> GENAUSO DUFTEND.',
    line: 'Uplift (Zitrone-Menthol) · Breathe (Eukalyptus-Menthol) · Balance (Orange-Bergamotte) · Calm (Lavendel-Mandarine) · Refresh (Limette-Zitronengras)',
  },
  en: {
    contents: 'Contents', scents: 'Scent composition', mix: 'Mix',
    availability: 'The selection of scents varies with what is in stock.',
    note1: 'One shower steamer lasts up to 3 showers.',
    note2: 'One steamer lasts up to 3 showers, so the whole pack gives you around 30.',
    save: 'SAVE', promo: 'IMPERFECT. <br> JUST AS FRAGRANT.',
    line: 'Uplift (Lemon-Menthol) · Breathe (Eucalyptus-Menthol) · Balance (Orange-Bergamot) · Calm (Lavender-Mandarin) · Refresh (Lime-Lemongrass)',
  },
  es: {
    contents: 'Contenido', scents: 'Composición de aromas', mix: 'Mezcla',
    availability: 'La selección de aromas varía según la disponibilidad.',
    note1: 'Un cubo de ducha dura hasta 3 duchas.',
    note2: 'Un cubo dura hasta 3 duchas, así que con todo el paquete tienes unas 30.',
    save: 'AHORRA', promo: 'IMPERFECTOS. <br> IGUAL DE AROMÁTICOS.',
    line: 'Uplift (Limón-Mentol) · Breathe (Eucalipto-Mentol) · Balance (Naranja-Bergamota) · Calm (Lavanda-Mandarina) · Refresh (Lima-Hierba limón)',
  },
  fr: {
    contents: 'Contenu', scents: 'Composition des parfums', mix: 'Mélange',
    availability: 'La sélection des parfums varie selon les disponibilités.',
    note1: 'Un galet de douche dure jusqu’à 3 douches.',
    note2: 'Un galet dure jusqu’à 3 douches, soit environ 30 douches pour le paquet entier.',
    save: 'ÉCONOMISE', promo: 'IMPARFAITS. <br> AUSSI PARFUMÉS.',
    line: 'Uplift (Citron-Menthol) · Breathe (Eucalyptus-Menthol) · Balance (Orange-Bergamote) · Calm (Lavande-Mandarine) · Refresh (Citron vert-Citronnelle)',
  },
  it: {
    contents: 'Contenuto', scents: 'Composizione delle fragranze', mix: 'Mix',
    availability: 'La selezione dei profumi varia in base alla disponibilità.',
    note1: 'Un cubo da doccia dura fino a 3 docce.',
    note2: 'Un cubo dura fino a 3 docce, quindi l’intera confezione ti dà circa 30 docce.',
    save: 'RISPARMIA', promo: 'IMPERFETTI. <br> UGUALMENTE PROFUMATI.',
    line: 'Uplift (Limone-Mentolo) · Breathe (Eucalipto-Mentolo) · Balance (Arancia-Bergamotto) · Calm (Lavanda-Mandarino) · Refresh (Lime-Citronella)',
  },
  nl: {
    contents: 'Inhoud', scents: 'Geurcompositie', mix: 'Mix',
    availability: 'De geurselectie hangt af van de actuele voorraad.',
    note1: 'Eén doucheblokje gaat tot 3 douchebeurten mee.',
    note2: 'Eén blokje gaat tot 3 douchebeurten mee, dus de hele verpakking geeft je zo’n 30 douchebeurten.',
    save: 'BESPAAR', promo: 'IMPERFECT. <br> NET ZO GEURIG.',
    line: 'Uplift (Citroen-Menthol) · Breathe (Eucalyptus-Menthol) · Balance (Sinaasappel-Bergamot) · Calm (Lavendel-Mandarijn) · Refresh (Limoen-Citroengras)',
  },
  hr: {
    contents: 'Sadržaj', scents: 'Kompozicija mirisa', mix: 'Miks',
    availability: 'Odabir mirisa ovisi o trenutnoj dostupnosti.',
    note1: 'Jedna kockica traje do 3 tuširanja.',
    note2: 'Jedna kockica traje do 3 tuširanja, pa iz cijelog pakiranja imaš oko 30 tuširanja.',
    save: 'UŠTEDI', promo: 'NESAVRŠENE. <br> JEDNAKO MIRISNE.',
    line: 'Uplift (Limun-Mentol) · Breathe (Eukaliptus-Mentol) · Balance (Naranča-Bergamot) · Calm (Lavanda-Mandarina) · Refresh (Limeta-Limunska trava)',
  },
  sl: {
    contents: 'Vsebina', scents: 'Kompozicija vonjev', mix: 'Mešanica',
    availability: 'Izbor vonjev je odvisen od trenutne zaloge.',
    note1: 'Ena kocka zadostuje za do 3 prhanja.',
    note2: 'Ena kocka zadostuje za do 3 prhanja, iz celega pakiranja jih dobiš približno 30.',
    save: 'PRIHRANI', promo: 'NEPOPOLNE. <br> ENAKO DIŠEČE.',
    line: 'Uplift (Limona-Mentol) · Breathe (Evkaliptus-Mentol) · Balance (Pomaranča-Bergamotka) · Calm (Sivka-Mandarina) · Refresh (Limeta-Limonska trava)',
  },
  bg: {
    contents: 'Съдържание', scents: 'Композиция на ароматите', mix: 'Микс',
    availability: 'Изборът на аромати зависи от текущата наличност.',
    note1: 'Едно кубче стига за до 3 душа.',
    note2: 'Едно кубче стига за до 3 душа, а от цялата опаковка получаваш около 30 душа.',
    save: 'СПЕСТИ', promo: 'НЕСЪВЪРШЕНИ. <br> СЪЩО ТОЛКОВА АРОМАТНИ.',
    line: 'Uplift (Лимон-Ментол) · Breathe (Евкалипт-Ментол) · Balance (Портокал-Бергамот) · Calm (Лавандула-Мандарина) · Refresh (Лайм-Лимонена трева)',
  },
};

const LOCALES = Object.keys(T);

/** Per-product copy: title, opening paragraph, and the Contents line. */
const COPY = {
  'PP-RSET-BUND-025': {
    sk: { title: 'Výhodná sada – 5 sprchových kociek + kamenná miska', intro: 'Vyskúšaj celý svet Perperuny v jednom rituáli. Päť vôní, päť nálad a kamenná miska, ktorá premení každú sprchu na wellness rituál.', contents: '5 sprchových kociek (1× každá vôňa) a kamenná miska' },
    cs: { title: 'Výhodné balení – 5 sprchových kostek + kamenná miska', intro: 'Vyzkoušej celý svět Perperuny v jednom rituálu. Pět vůní, pět nálad a kamenná miska, která promění každou sprchu ve wellness rituál.', contents: '5 sprchových kostek (1× každá vůně) a kamenná miska' },
    pl: { title: 'Zestaw korzystny – 5 kostek pod prysznic + kamienna miska', intro: 'Poznaj cały świat Perperuny w jednym rytuale. Pięć zapachów, pięć nastrojów i kamienna miska, która zamienia każdy prysznic w rytuał wellness.', contents: '5 kostek pod prysznic (1× każdy zapach) i kamienna miska' },
    ro: { title: 'Set avantajos – 5 cuburi pentru duș + bol din piatră', intro: 'Descoperă întreaga lume Perperuna într-un singur ritual. Cinci arome, cinci stări și un bol din piatră care transformă fiecare duș într-un ritual de wellness.', contents: '5 cuburi pentru duș (1× fiecare aromă) și un bol din piatră' },
    hu: { title: 'Kedvezményes szett – 5 zuhanykocka + kőtál', intro: 'Fedezd fel a Perperuna teljes világát egyetlen rituáléban. Öt illat, öt hangulat és egy kőtál, amely minden zuhanyzást wellness rituálévá változtat.', contents: '5 zuhanykocka (1× minden illat) és egy kőtál' },
    de: { title: 'Vorteilsset – 5 Duschwürfel + Steinschale', intro: 'Entdecke die ganze Welt von Perperuna in einem Ritual. Fünf Düfte, fünf Stimmungen und eine Steinschale, die jede Dusche in ein Wellness-Ritual verwandelt.', contents: '5 Duschwürfel (1× jeder Duft) und eine Steinschale' },
    en: { title: 'Value set – 5 shower steamers + stone bowl', intro: 'Try the whole world of Perperuna in one ritual. Five scents, five moods and a stone bowl that turns every shower into a wellness ritual.', contents: '5 shower steamers (1× each scent) and a stone bowl' },
    es: { title: 'Set ventajoso – 5 cubos de ducha + cuenco de piedra', intro: 'Descubre todo el mundo de Perperuna en un solo ritual. Cinco aromas, cinco estados de ánimo y un cuenco de piedra que convierte cada ducha en un ritual de bienestar.', contents: '5 cubos de ducha (1× cada aroma) y un cuenco de piedra' },
    fr: { title: 'Coffret avantageux – 5 galets de douche + coupelle en pierre', intro: 'Découvre tout l’univers Perperuna en un seul rituel. Cinq parfums, cinq humeurs et une coupelle en pierre qui transforme chaque douche en rituel bien-être.', contents: '5 galets de douche (1× chaque parfum) et une coupelle en pierre' },
    it: { title: 'Set convenienza – 5 cubi da doccia + ciotola di pietra', intro: 'Scopri tutto il mondo Perperuna in un solo rituale. Cinque profumi, cinque stati d’animo e una ciotola di pietra che trasforma ogni doccia in un rituale di benessere.', contents: '5 cubi da doccia (1× ogni profumo) e una ciotola di pietra' },
    nl: { title: 'Voordeelset – 5 doucheblokjes + stenen schaal', intro: 'Ontdek de hele wereld van Perperuna in één ritueel. Vijf geuren, vijf stemmingen en een stenen schaal die elke douche in een wellnessritueel verandert.', contents: '5 doucheblokjes (1× elke geur) en een stenen schaal' },
    hr: { title: 'Povoljni set – 5 kockica za tuširanje + kamena zdjelica', intro: 'Otkrij cijeli svijet Perperune u jednom ritualu. Pet mirisa, pet raspoloženja i kamena zdjelica koja svako tuširanje pretvara u wellness ritual.', contents: '5 kockica za tuširanje (1× svaki miris) i kamena zdjelica' },
    sl: { title: 'Ugodni set – 5 kock za prhanje + kamena skledica', intro: 'Odkrij cel svet Perperune v enem ritualu. Pet vonjev, pet razpoloženj in kamena skledica, ki vsako prhanje spremeni v wellness ritual.', contents: '5 kock za prhanje (1× vsak vonj) in kamena skledica' },
    bg: { title: 'Изгоден комплект – 5 душ кубчета + каменна купа', intro: 'Открий целия свят на Perperuna в един ритуал. Пет аромата, пет настроения и каменна купа, която превръща всеки душ в уелнес ритуал.', contents: '5 душ кубчета (1× всеки аромат) и каменна купа' },
  },
  'PP-CUBE-BUND-034': {
    sk: { title: 'Výhodná sada – 10 sprchových kociek', intro: 'Desať sprchových kociek, dve od každej vône. Kompletná kolekcia Perperuny v jednom balení.', contents: '10 sprchových kociek (2× každá vôňa)' },
    cs: { title: 'Výhodné balení – 10 sprchových kostek', intro: 'Deset sprchových kostek, dvě od každé vůně. Kompletní kolekce Perperuny v jednom balení.', contents: '10 sprchových kostek (2× každá vůně)' },
    pl: { title: 'Zestaw korzystny – 10 kostek pod prysznic', intro: 'Dziesięć kostek pod prysznic, po dwie z każdego zapachu. Kompletna kolekcja Perperuny w jednym opakowaniu.', contents: '10 kostek pod prysznic (2× każdy zapach)' },
    ro: { title: 'Set avantajos – 10 cuburi pentru duș', intro: 'Zece cuburi pentru duș, câte două din fiecare aromă. Colecția completă Perperuna într-un singur pachet.', contents: '10 cuburi pentru duș (2× fiecare aromă)' },
    hu: { title: 'Kedvezményes szett – 10 zuhanykocka', intro: 'Tíz zuhanykocka, mindegyik illatból kettő. A teljes Perperuna kollekció egyetlen csomagban.', contents: '10 zuhanykocka (2× minden illat)' },
    de: { title: 'Vorteilsset – 10 Duschwürfel', intro: 'Zehn Duschwürfel, zwei von jedem Duft. Die komplette Perperuna-Kollektion in einer Packung.', contents: '10 Duschwürfel (2× jeder Duft)' },
    en: { title: 'Value set – 10 shower steamers', intro: 'Ten shower steamers, two of each scent. The complete Perperuna collection in one pack.', contents: '10 shower steamers (2× each scent)' },
    es: { title: 'Set ventajoso – 10 cubos de ducha', intro: 'Diez cubos de ducha, dos de cada aroma. La colección completa de Perperuna en un solo paquete.', contents: '10 cubos de ducha (2× cada aroma)' },
    fr: { title: 'Coffret avantageux – 10 galets de douche', intro: 'Dix galets de douche, deux de chaque parfum. La collection Perperuna complète en un seul paquet.', contents: '10 galets de douche (2× chaque parfum)' },
    it: { title: 'Set convenienza – 10 cubi da doccia', intro: 'Dieci cubi da doccia, due per ogni profumo. La collezione Perperuna completa in una sola confezione.', contents: '10 cubi da doccia (2× ogni profumo)' },
    nl: { title: 'Voordeelset – 10 doucheblokjes', intro: 'Tien doucheblokjes, twee van elke geur. De complete Perperuna-collectie in één verpakking.', contents: '10 doucheblokjes (2× elke geur)' },
    hr: { title: 'Povoljni set – 10 kockica za tuširanje', intro: 'Deset kockica za tuširanje, po dvije od svakog mirisa. Kompletna Perperuna kolekcija u jednom pakiranju.', contents: '10 kockica za tuširanje (2× svaki miris)' },
    sl: { title: 'Ugodni set – 10 kock za prhanje', intro: 'Deset kock za prhanje, po dve od vsakega vonja. Celotna kolekcija Perperuna v enem pakiranju.', contents: '10 kock za prhanje (2× vsak vonj)' },
    bg: { title: 'Изгоден комплект – 10 душ кубчета', intro: 'Десет душ кубчета, по две от всеки аромат. Пълната колекция Perperuna в една опаковка.', contents: '10 душ кубчета (2× всеки аромат)' },
  },
  'PP-NUBE-NEDO-035': {
    sk: { title: '10 nedokonalých sprchových kociek', intro: 'Nie každá kocka musí vyzerať dokonalo, aby fungovala dokonalo. Tieto kúsky majú drobnú kozmetickú vadu no vôňa, zloženie aj zážitok zo sprchy zostávajú úplne rovnaké. Ideálna voľba na každodenný domáci wellness za výhodnejšiu cenu.', contents: '10 nedokonalých sprchových kociek, mix vôní' },
    cs: { title: '10 nedokonalých sprchových kostek', intro: 'Ne každá kostka musí vypadat dokonale, aby fungovala dokonale. Tyto kousky mají drobnou kosmetickou vadu, ale vůně, složení i zážitek ze sprchy zůstávají úplně stejné. Ideální volba na každodenní domácí wellness za výhodnější cenu.', contents: '10 nedokonalých sprchových kostek, mix vůní' },
    pl: { title: '10 niedoskonałych kostek pod prysznic', intro: 'Nie każda kostka musi wyglądać idealnie, żeby idealnie działać. Te sztuki mają drobną wadę kosmetyczną, ale zapach, skład i wrażenia pod prysznicem pozostają dokładnie takie same. Idealny wybór na codzienny domowy wellness w korzystniejszej cenie.', contents: '10 niedoskonałych kostek pod prysznic, mix zapachów' },
    ro: { title: '10 cuburi pentru duș imperfecte', intro: 'Nu fiecare cub trebuie să arate perfect ca să funcționeze perfect. Aceste bucăți au un mic defect cosmetic, dar aroma, compoziția și experiența de la duș rămân exact aceleași. Alegerea ideală pentru wellness-ul zilnic de acasă, la un preț mai avantajos.', contents: '10 cuburi pentru duș imperfecte, mix de arome' },
    hu: { title: '10 tökéletlen zuhanykocka', intro: 'Nem kell minden kockának tökéletesen kinéznie ahhoz, hogy tökéletesen működjön. Ezeken a darabokon apró kozmetikai hiba van, de az illat, az összetétel és a zuhanyzás élménye ugyanaz marad. Ideális választás a mindennapi otthoni wellnesshez, kedvezőbb áron.', contents: '10 tökéletlen zuhanykocka, illatmix' },
    de: { title: '10 unperfekte Duschwürfel', intro: 'Nicht jeder Würfel muss perfekt aussehen, um perfekt zu funktionieren. Diese Stücke haben einen kleinen Schönheitsfehler, doch Duft, Zusammensetzung und Duscherlebnis bleiben genau gleich. Die ideale Wahl für tägliches Wellness zu Hause, zum besseren Preis.', contents: '10 unperfekte Duschwürfel, Duftmix' },
    en: { title: '10 imperfect shower steamers', intro: 'Not every steamer has to look perfect to work perfectly. These have a small cosmetic flaw, but the scent, the ingredients and the shower itself stay exactly the same. The ideal choice for everyday wellness at home, at a better price.', contents: '10 imperfect shower steamers, mixed scents' },
    es: { title: '10 cubos de ducha imperfectos', intro: 'No todos los cubos tienen que verse perfectos para funcionar a la perfección. Estas piezas tienen un pequeño defecto estético, pero el aroma, la composición y la experiencia en la ducha siguen siendo idénticos. La elección ideal para el bienestar diario en casa, a mejor precio.', contents: '10 cubos de ducha imperfectos, mezcla de aromas' },
    fr: { title: '10 galets de douche imparfaits', intro: 'Un galet n’a pas besoin d’être parfait pour fonctionner parfaitement. Ces pièces présentent un petit défaut esthétique, mais le parfum, la composition et l’expérience sous la douche restent exactement les mêmes. Le choix idéal pour le bien-être quotidien à la maison, à meilleur prix.', contents: '10 galets de douche imparfaits, assortiment de parfums' },
    it: { title: '10 cubi da doccia imperfetti', intro: 'Non tutti i cubi devono essere perfetti per funzionare alla perfezione. Questi pezzi hanno un piccolo difetto estetico, ma profumo, composizione ed esperienza sotto la doccia restano identici. La scelta ideale per il benessere quotidiano a casa, a un prezzo migliore.', contents: '10 cubi da doccia imperfetti, mix di profumi' },
    nl: { title: '10 imperfecte doucheblokjes', intro: 'Niet elk blokje hoeft er perfect uit te zien om perfect te werken. Deze exemplaren hebben een klein cosmetisch mankement, maar de geur, de samenstelling en de douchebeleving blijven precies hetzelfde. De ideale keuze voor dagelijkse wellness thuis, voor een betere prijs.', contents: '10 imperfecte doucheblokjes, geurenmix' },
    hr: { title: '10 nesavršenih kockica za tuširanje', intro: 'Ne mora svaka kockica izgledati savršeno da bi savršeno radila. Ovi komadi imaju sitnu kozmetičku manu, ali miris, sastav i doživljaj tuširanja ostaju potpuno isti. Idealan izbor za svakodnevni wellness kod kuće, po povoljnijoj cijeni.', contents: '10 nesavršenih kockica za tuširanje, miks mirisa' },
    sl: { title: '10 nepopolnih kock za prhanje', intro: 'Ni nujno, da je vsaka kocka videti popolna, da deluje popolno. Ti kosi imajo drobno kozmetično napako, a vonj, sestava in doživetje prhanja ostanejo popolnoma enaki. Idealna izbira za vsakodnevni wellness doma, po ugodnejši ceni.', contents: '10 nepopolnih kock za prhanje, mešanica vonjev' },
    bg: { title: '10 несъвършени душ кубчета', intro: 'Не всяко кубче трябва да изглежда съвършено, за да работи съвършено. Тези бройки имат малък козметичен дефект, но ароматът, съставът и усещането под душа остават напълно същите. Идеалният избор за ежедневен уелнес у дома, на по-изгодна цена.', contents: '10 несъвършени душ кубчета, микс от аромати' },
  },
};

/**
 * Prices per backend. Built the same way as the Slovak ones: the reference
 * price is what the parts cost separately in that market, and the selling price
 * keeps the Slovak discount, rounded onto the local price ladder.
 */
const PRICING = {
  'PP-RSET-BUND-025': {
    cz: ['990', '1490'], ro: ['209.90', '314.90'], pl: ['174.90', '261.90'], hu: ['14490', '21740'],
  },
  'PP-CUBE-BUND-034': {
    cz: ['1099', '1990'], ro: ['235.90', '419.00'], pl: ['196.90', '349.00'], hu: ['16290', '28900'],
  },
  // Ten seconds is ten times the local price of one, same as on SK.
  'PP-NUBE-NEDO-035': {
    cz: ['790', '1990'], ro: ['168.90', '419.00'], pl: ['138.90', '349.00'], hu: ['11890', '28900'],
  },
};

const HANDLES = {
  'PP-RSET-BUND-025': {
    cz: 'vyhodne-baleni-5-sprchovych-kostek-kamenna-miska',
    ro: 'set-avantajos-5-cuburi-bol-din-piatra',
    pl: 'zestaw-korzystny-5-kostek-kamienna-miska',
    hu: 'kedvezmenyes-szett-5-zuhanykocka-kotal',
  },
  'PP-CUBE-BUND-034': {
    cz: 'vyhodne-baleni-10-sprchovych-kostek',
    ro: 'set-avantajos-10-cuburi-pentru-dus',
    pl: 'zestaw-korzystny-10-kostek-pod-prysznic',
    hu: 'kedvezmenyes-szett-10-zuhanykocka',
  },
  'PP-NUBE-NEDO-035': {
    cz: '10-nedokonalych-sprchovych-kostek',
    ro: '10-cuburi-pentru-dus-imperfecte',
    pl: '10-niedoskonalych-kostek-pod-prysznic',
    hu: '10-tokeletlen-zuhanykocka',
  },
};

/** Collections each backend files cube products under. Frontpage is left out. */
const COLLECTIONS = {
  cz: ['sprhove-kostky', 'kostky', 'aromaticke-kostky', 'aromaticke-kocky-2'],
  ro: ['ritualuri-aromatice'],
  pl: ['aromatyczne-rytualy', 'all'],
  hu: ['aromas-ritualek', 'perperuna-kollekcio', 'all'],
};

const SPEC = {
  'PP-RSET-BUND-025': { discount: 33, weight: 550, tags: ['_alt_bundle', 'bundle'], note: 'note1', scentLine: 'line' },
  'PP-CUBE-BUND-034': { discount: 44, weight: 730, tags: ['_alt_kocky', 'kocka'], note: 'note2', scentLine: 'line' },
  'PP-NUBE-NEDO-035': { discount: 60, weight: 730, tags: ['_alt_kocky', 'kocka'], note: 'note2', scentLine: 'mix', promo: true },
};

const SKUS = Object.keys(SPEC);

// ---- shaping --------------------------------------------------------------

const PLAIN_SCENTS = 'Uplift · Breathe · Balance · Calm · Refresh';

function describe(sku, locale) {
  const c = COPY[sku][locale];
  const t = T[locale];
  const spec = SPEC[sku];
  const scents = spec.scentLine === 'mix'
    ? `${t.mix}: ${PLAIN_SCENTS}. ${t.availability}`
    : t.line;
  return `<div class="pp-spec-card">
<div class="pp-spec-intro">${c.intro}</div>
<dl>
<dt>${t.contents}</dt>
<dd>${c.contents}</dd>
<dt>${t.scents}</dt>
<dd>${scents}</dd>
</dl>
<div class="pp-inline-info">
<span class="pp-info-icon">i</span>${t[spec.note]}</div>
</div>`;
}

/** A meta description is capped by search engines, so cut on a sentence. */
function seoDescription(sku, locale) {
  const intro = COPY[sku][locale].intro;
  if (intro.length <= 160) return intro;
  const cut = intro.slice(0, 160);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

const seoTitle = (sku, locale) => `${COPY[sku][locale].title} | PERPERUNA`;
const heroLabel = (sku, locale) => `${T[locale].save} ${SPEC[sku].discount} %`;

// ---- Shopify --------------------------------------------------------------

const REGISTER = `mutation T($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations { locale key } userErrors { field message }
  }
}`;

const CREATE = `mutation C($input: ProductInput!, $media: [CreateMediaInput!]) {
  productCreate(input: $input, media: $media) {
    product { id handle variants(first: 1) { nodes { id } } }
    userErrors { field message }
  }
}`;

const VARIANT = `mutation V($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
}`;

const SET_QTY = `mutation Q($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) { userErrors { field message code } }
}`;

async function bySku(store, sku) {
  const d = await graphql(store, `query($q: String!) {
    productVariants(first: 20, query: $q) { nodes { sku product { id handle status } } }
  }`, { q: `sku:${sku}` });
  const found = new Map();
  for (const v of d.productVariants.nodes) {
    if (v.sku?.trim() === sku) found.set(v.product.id, v.product);
  }
  return [...found.values()];
}

async function byHandle(store, handle) {
  const d = await graphql(store, `query($h: String!) { productByHandle(handle: $h) { id handle status } }`, { h: handle });
  return d.productByHandle;
}

/** Everything the new product should inherit from what the backend already has. */
async function backendContext(store) {
  const calm = (await bySku(store, 'PP-CUBE-CALM-004'))[0];
  const ritual = (await bySku(store, 'PP-RSET-RITL-010')).find((p) => p.status === 'ACTIVE');
  if (!calm) throw new Error(`[${store}] Calm cube not found — cannot read the shared metafields`);

  const shared = await graphql(store, `query($calm: ID!, $ritual: ID!) {
    calm: product(id: $calm) {
      na: metafield(namespace: "custom", key: "navod") { value }
      fa: metafield(namespace: "custom", key: "faq") { value }
    }
    ritual: product(id: $ritual) {
      re: metafield(namespace: "custom", key: "recenzie") { value }
    }
    metaobjects(type: "benefit_vone", first: 30) { nodes { id fields { key value } } }
  }`, { calm: calm.id, ritual: ritual?.id ?? calm.id });

  const named = new Map();
  for (const m of shared.metaobjects.nodes) {
    named.set(m.fields.find((f) => f.key === 'nazov')?.value ?? '', m.id);
  }
  const scents = ['Uplift', 'Breathe', 'Balance', 'Calm', 'Refresh'].map((n) => named.get(n)).filter(Boolean);
  // The generic block is the only one whose name is not a scent — it reads
  // "Sety – obecné", "Zestawy – ogólne" and so on.
  const generic = [...named.entries()].find(([n]) => n.includes('–') || n.includes('-'))?.[1];

  // Ingredient card: the four scent lists this backend already carries, plus Refresh.
  const blocks = [];
  for (const [name, sku] of [
    ['Uplift', 'PP-CUBE-UPLI-001'], ['Breathe', 'PP-CUBE-BREA-002'],
    ['Balance', 'PP-CUBE-BALA-003'], ['Calm', 'PP-CUBE-CALM-004'],
    ['Refresh', 'PP-CUBE-REFR-033'],
  ]) {
    const p = (await bySku(store, sku))[0];
    if (!p) continue;
    const d = await graphql(store, `query($id: ID!) {
      product(id: $id) { metafield(namespace: "custom", key: "zlozenie") { value } }
    }`, { id: p.id });
    const text = d.product.metafield?.value;
    if (!text) continue;
    const lines = text.trim().split('\n');
    const last = lines[lines.length - 1].trim();
    const body = last.startsWith('*') ? lines.slice(0, -1).join('\n') : text.trim();
    const footnote = last.startsWith('*') ? last : '';
    blocks.push(`<div class="pp-ingredients-block">\n<h4>${name}</h4>\n<p>\n${body}\n` +
      `<br><span style='font-size:13px;opacity:.75'>${footnote}</span>\n</p>\n</div>`);
  }

  const collections = [];
  for (const handle of COLLECTIONS[store]) {
    const d = await graphql(store, `query($h: String!) { collectionByHandle(handle: $h) { id } }`, { h: handle });
    if (d.collectionByHandle) collections.push(d.collectionByHandle.id);
  }

  const loc = await graphql(store, '{ locations(first: 10) { nodes { id isActive } } }');
  const active = loc.locations.nodes.filter((l) => l.isActive);
  if (active.length !== 1) throw new Error(`[${store}] expected one active location, found ${active.length}`);

  return {
    navod: shared.calm?.na?.value,
    faq: shared.calm?.fa?.value,
    recenzie: shared.ritual?.re?.value,
    benefity: JSON.stringify([generic, ...scents].filter(Boolean)),
    zlozenie: blocks.length ? `<div class="pp-ingredients-card">${blocks.join('')}</div>` : null,
    scentBlocks: blocks.length,
    collections,
    locationId: active[0].id,
  };
}

/** Media on the Slovak originals, which is what the other markets should show. */
async function sourceMedia(sku) {
  const p = (await bySku(SOURCE, sku))[0];
  const d = await graphql(SOURCE, `query($id: ID!) {
    product(id: $id) { media(first: 25) { nodes { ... on MediaImage { image { url } } } } }
  }`, { id: p.id });
  return d.product.media.nodes.map((m) => m.image?.url).filter(Boolean);
}

// ---- run ------------------------------------------------------------------

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const doTranslate = args.includes('--translate');
const doCreate = args.includes('--create');
const onlyStore = args.find((a) => a.startsWith('--store='))?.slice('--store='.length);

if (!doTranslate && !doCreate) {
  console.error('Pass --translate, --create, or both.');
  process.exit(1);
}
console.log(apply ? '*** APPLY — writing to Shopify ***\n' : 'dry run — nothing will be written\n');

let writes = 0;

if (doTranslate) {
  const d = await graphql(SOURCE, '{ shopLocales { locale primary } }');
  const secondary = d.shopLocales.filter((l) => !l.primary).map((l) => l.locale)
    .filter((l) => LOCALES.includes(l));

  for (const sku of SKUS) {
    const product = (await bySku(SOURCE, sku))[0];
    if (!product) { console.log(`! ${sku} nie je na SK`); continue; }
    console.log(`=== ${sku}  ${product.handle}`);

    // Translations are pinned to a digest of the source text, so read the
    // digests now — they change whenever the Slovak original is edited.
    const res = await graphql(SOURCE, `query($id: ID!) {
      translatableResource(resourceId: $id) { translatableContent { key digest } }
    }`, { id: product.id });
    const digest = Object.fromEntries(
      res.translatableResource.translatableContent.map((c) => [c.key, c.digest]),
    );

    for (const locale of secondary) {
      const entries = [
        ['title', COPY[sku][locale].title],
        ['body_html', describe(sku, locale)],
        ['meta_title', seoTitle(sku, locale)],
        ['meta_description', seoDescription(sku, locale)],
      ].filter(([key]) => digest[key]).map(([key, value]) => ({
        locale, key, value, translatableContentDigest: digest[key],
      }));

      console.log(`    ${locale}: ${entries.map((e) => e.key).join(', ')}`);
      console.log(`        ${COPY[sku][locale].title}`);
      if (!apply) continue;

      const r = await graphql(SOURCE, REGISTER, { resourceId: product.id, translations: entries });
      const errs = r.translationsRegister.userErrors;
      if (errs.length) console.log(`        ✗ ${JSON.stringify(errs)}`);
      else writes += entries.length;

      // hero_label and promo are metafields, translated on their own resource.
      const mfs = await graphql(SOURCE, `query($id: ID!) {
        product(id: $id) {
          hl: metafield(namespace: "custom", key: "hero_label") { id }
          pr: metafield(namespace: "custom", key: "promo") { id }
          hb: metafield(namespace: "custom", key: "hero_label_bottom") { id }
        }
      }`, { id: product.id });
      for (const [field, value] of [
        [mfs.product.hl, heroLabel(sku, locale)],
        [mfs.product.pr, SPEC[sku].promo ? T[locale].promo : null],
        [mfs.product.hb, SPEC[sku].promo ? T[locale].promo : null],
      ]) {
        if (!field || !value) continue;
        const dg = await graphql(SOURCE, `query($id: ID!) {
          translatableResource(resourceId: $id) { translatableContent { key digest } }
        }`, { id: field.id });
        const mdigest = dg.translatableResource?.translatableContent?.find((c) => c.key === 'value')?.digest;
        if (!mdigest) continue;
        const rr = await graphql(SOURCE, REGISTER, {
          resourceId: field.id,
          translations: [{ locale, key: 'value', value, translatableContentDigest: mdigest }],
        });
        if (!rr.translationsRegister.userErrors.length) writes++;
      }
    }
    console.log();
  }
}

if (doCreate) {
  for (const store of TARGETS.filter((s) => !onlyStore || s === onlyStore)) {
    console.log(`########## ${store.toUpperCase()}`);
    const lang = LOCALE_OF[store];
    const ctx = await backendContext(store);
    console.log(`   zdedené: navod ${ctx.navod ? 'áno' : 'NIE'}, faq ${ctx.faq ? 'áno' : 'NIE'}, ` +
      `recenzie ${ctx.recenzie ? 'áno' : 'NIE'}, zloženie ${ctx.scentBlocks}/5 vôní, ` +
      `kolekcie ${ctx.collections.length}/${COLLECTIONS[store].length}\n`);

    for (const sku of SKUS) {
      const handle = HANDLES[sku][store];
      const [price, compareAtPrice] = PRICING[sku][store];
      const spec = SPEC[sku];

      const clash = await byHandle(store, handle) ?? (await bySku(store, sku))[0];
      console.log(`=== ${sku}  ${COPY[sku][lang].title}`);
      console.log(`    handle ${handle}${clash ? `   !! už existuje (${clash.handle}, ${clash.status}) — preskakujem` : ''}`);
      console.log(`    cena ${price} (pôvodne ${compareAtPrice}), ${heroLabel(sku, lang)}, ${spec.weight} g, DRAFT, sklad ${START_QUANTITY}`);
      if (clash) { console.log(); continue; }

      const urls = await sourceMedia(sku);
      console.log(`    médiá ${urls.length}`);
      if (!apply) { console.log(); continue; }

      const metafields = [
        ctx.zlozenie && { namespace: 'custom', key: 'zlozenie', type: 'multi_line_text_field', value: ctx.zlozenie },
        ctx.benefity && { namespace: 'custom', key: 'benefity', type: 'list.metaobject_reference', value: ctx.benefity },
        ctx.navod && { namespace: 'custom', key: 'navod', type: 'metaobject_reference', value: ctx.navod },
        ctx.faq && { namespace: 'custom', key: 'faq', type: 'list.metaobject_reference', value: ctx.faq },
        ctx.recenzie && { namespace: 'custom', key: 'recenzie', type: 'list.metaobject_reference', value: ctx.recenzie },
        { namespace: 'custom', key: 'hero_label', type: 'single_line_text_field', value: heroLabel(sku, lang) },
        spec.promo && { namespace: 'custom', key: 'promo', type: 'single_line_text_field', value: T[lang].promo },
        spec.promo && { namespace: 'custom', key: 'hero_label_bottom', type: 'single_line_text_field', value: T[lang].promo },
      ].filter(Boolean);

      const res = await graphql(store, CREATE, {
        input: {
          title: COPY[sku][lang].title,
          handle,
          descriptionHtml: describe(sku, lang),
          status: 'DRAFT',
          tags: spec.tags,
          collectionsToJoin: ctx.collections,
          seo: { title: seoTitle(sku, lang), description: seoDescription(sku, lang) },
          metafields,
        },
        media: urls.map((url) => ({
          mediaContentType: 'IMAGE', originalSource: url, alt: COPY[sku][lang].title,
        })),
      });
      const errs = res.productCreate.userErrors;
      if (errs.length) { console.log(`    ✗ productCreate: ${JSON.stringify(errs)}\n`); continue; }

      const product = res.productCreate.product;
      const variantId = product.variants.nodes[0].id;

      const vr = await graphql(store, VARIANT, {
        productId: product.id,
        variants: [{
          id: variantId, price, compareAtPrice,
          inventoryItem: {
            sku, tracked: true, requiresShipping: true,
            measurement: { weight: { value: spec.weight, unit: 'GRAMS' } },
          },
        }],
      });
      if (vr.productVariantsBulkUpdate.userErrors.length) {
        console.log(`    ✗ variant: ${JSON.stringify(vr.productVariantsBulkUpdate.userErrors)}\n`);
        continue;
      }

      const inv = await graphql(store, `query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`, { id: variantId });
      await graphql(store, SET_QTY, {
        input: {
          reason: 'correction', name: 'available',
          referenceDocumentUri: `gid://perperuna-catalog/Rollout/${sku}`,
          ignoreCompareQuantity: true,
          quantities: [{ inventoryItemId: inv.productVariant.inventoryItem.id, locationId: ctx.locationId, quantity: START_QUANTITY }],
        },
      });

      writes++;
      console.log(`    ✓ vytvorené — ${product.id}\n`);
    }
  }
}

console.log(apply ? `Done. ${writes} zápis(ov).` : 'Dry run complete. Re-run with --apply.');
