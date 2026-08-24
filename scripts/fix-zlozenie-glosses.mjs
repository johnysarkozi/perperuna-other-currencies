#!/usr/bin/env node
/**
 * Normalises every ingredient list to the house form: the INCI name in Latin,
 * the local translation in brackets after it.
 *
 *   node scripts/fix-zlozenie-glosses.mjs           # dry run, prints every diff
 *   node scripts/fix-zlozenie-glosses.mjs --apply   # write
 *   node scripts/fix-zlozenie-glosses.mjs --store=sk --locale=fr
 *
 * Three kinds of defect, found by harvesting all custom.zlozenie values and
 * their translations across the five backends:
 *
 *   1. Slovak glosses left in other languages. "Aqua (Voda)" in French,
 *      "Maranta Arundinacea Root Powder (Arorut)" in Dutch, and so on — the
 *      translator rendered most of the line and left the rest.
 *
 *   2. One ingredient with several names inside the same language, mostly on
 *      German (Natriumbicarbonat / Natriumbikarbonat / Natron for one thing).
 *
 *   3. Bulgarian written the other way round: the ingredient name transliterated
 *      into Cyrillic and the INCI in brackets, or no INCI at all. INCI has to be
 *      the Latin name, so those lists are rebuilt from the Slovak one with
 *      Bulgarian glosses.
 *
 * Replacements are keyed to the exact wrong text, never "whatever is in
 * brackets" — a gloss that is merely different from the majority is often a
 * legitimate short or long form (Eukalyptus vs Eukalyptový olej) and must
 * survive.
 */

import { graphql, paginate } from '../lib/shopify.mjs';

const STORES = ['sk', 'cz', 'ro', 'pl', 'hu'];

/**
 * term → locale → { wrong gloss: right gloss }.
 * Only these exact strings are touched.
 */
const FIXES = {
  Aqua: {
    en: { Voda: 'water' }, es: { Voda: 'agua' }, fr: { Voda: 'eau' },
    it: { Voda: 'acqua' }, nl: { Voda: 'water' },
    hr: { Voda: 'voda' }, sl: { Voda: 'voda' },
  },
  'Centaurea Cyanus Flower': {
    en: { 'Nevädza': 'cornflower' }, es: { 'Nevädza': 'aciano' },
    fr: { 'Nevädza': 'bleuet' }, it: { 'Nevädza': 'fiordaliso' },
    nl: { 'Nevädza': 'korenbloem' }, hr: { 'Nevädza': 'različak' },
    sl: { 'Nevädza': 'plavica' },
  },
  'Cocos Nucifera Flour': {
    en: { Kokos: 'coconut' }, es: { Kokos: 'coco' }, fr: { Kokos: 'noix de coco' },
    it: { Kokos: 'cocco' }, nl: { Kokos: 'kokos' },
    hr: { Kokos: 'kokos' }, sl: { Kokos: 'kokos' },
  },
  // Only the bare "Eukalyptus" form is wrong; the "…ový olej" long forms are
  // a real distinction in the source and stay.
  'Eucalyptus Globulus Leaf Oil': {
    en: { Eukalyptus: 'eucalyptus' }, es: { Eukalyptus: 'eucalipto' },
    fr: { Eukalyptus: 'eucalyptus' }, it: { Eukalyptus: 'eucalipto' },
    nl: { Eukalyptus: 'eucalyptus' }, hr: { Eukalyptus: 'eukaliptus' },
    sl: { Eukalyptus: 'evkaliptus' },
  },
  'Maranta Arundinacea Root Powder': {
    en: { Arorut: 'arrowroot' }, es: { Arorut: 'arrurruz' }, fr: { Arorut: 'arrow-root' },
    it: { Arorut: 'arrowroot' }, nl: { Arorut: 'arrowroot' },
    hr: { Arorut: 'arrowroot' }, sl: { Arorut: 'arrowroot' },
    de: {
      Pfeilwurz: 'Pfeilwurzelpulver', Arrowroot: 'Pfeilwurzelpulver',
      Pfeilwurzpulver: 'Pfeilwurzelpulver', Pfeilwurzel: 'Pfeilwurzelpulver',
    },
  },
  // German "Menthol" is already right. Spanish, Croatian and Slovene spell it
  // "mentol" — only the Slovak capital letter is out of place, since every
  // other gloss in those languages is lower case.
  Menthol: {
    en: { Mentol: 'menthol' }, fr: { Mentol: 'menthol' },
    it: { Mentol: 'mentolo' }, nl: { Mentol: 'menthol' },
    es: { Mentol: 'mentol' }, hr: { Mentol: 'mentol' }, sl: { Mentol: 'mentol' },
  },
  // An English word sitting in the Slovak and Czech lists.
  'Zea Mays': {
    sk: { Cornflour: 'Kukuričná múka' }, cs: { Cornflour: 'Kukuřičná mouka' },
    de: { Maisstärke: 'Maismehl' },
  },
  'Sodium Bicarbonate': { de: { Natriumbikarbonat: 'Natriumbicarbonat', Natron: 'Natriumbicarbonat' } },
  'Citrus Aurantium Bergamia Fruit Oil': { de: { 'Bergamottöl': 'Bergamotteöl' } },
  'Citrus Bergamia Fruit Oil': { de: { 'Bergamottöl': 'Bergamotteöl' } },
  'Pelargonium Graveolens Flower Oil': { de: { 'Geraniumöl': 'Geranienöl' } },
  'Piper Nigrum Fruit Oil': { de: { 'Schwarzer Pfeffer Öl': 'Schwarzer Pfefferöl' } },
  'Mentha Viridis Leaf Oil': { de: { Krauseminze: 'Grüne Minze' } },
  'Theobroma Cacao Shell Powder': { de: { Kakaoschalen: 'Kakaoschalenpulver' } },
  'Clitoria Ternatea Flower': { de: { 'Schmetterlingsblüte': 'Schmetterlingserbse' } },
  'Abies Sibirica Needle Oil': {
    de: { 'Sibirisches Tannenöl': 'Sibirisches Fichtennadelöl', 'Sibirisches Fichtenöl': 'Sibirisches Fichtennadelöl' },
  },
  'Litsea Cubeba Fruit Oil': {
    bg: {
      'Мей Чанг': 'Май Чанг', 'Масло от May Chang': 'Май Чанг', 'Литцеа кубеба': 'Май Чанг',
      'Литсея кубеба': 'Май Чанг', 'Лицеа кубеба': 'Май Чанг', 'Литцея кубеба': 'Май Чанг',
    },
  },
};

/** INCI names written in the local language instead of Latin. */
const TERM_FIXES = { de: { Natriumchlorid: 'Sodium Chloride' } };

/**
 * Bulgarian glosses, for the lists that have to be rebuilt from Slovak.
 * Taken from the Bulgarian entries that were already in the right shape.
 */
const BG = {
  'Sodium Bicarbonate': 'Сода бикарбонат',
  'Citric Acid': 'Лимонена киселина',
  'Zea Mays Starch': 'Царевично нишесте',
  'Zea Mays': 'Царевично брашно',
  Aqua: 'Вода',
  'Sodium Chloride': 'Хималайска сол',
  'Maranta Arundinacea Root Powder': 'Арорут',
  Menthol: 'Ментол',
  Kaolin: 'Бяла глина',
  'Citrus Limon Peel Oil': 'Лимоново масло',
  'Citrus Nobilis Peel Oil': 'Масло от мандарина',
  'Citrus Reticulata Peel Oil': 'Масло от мандарина',
  'Citrus Aurantium Dulcis Peel Oil': 'Масло от сладък портокал',
  'Citrus Sinensis Peel Oil': 'Масло от сладък портокал',
  'Citrus Sinensis Peel Powder': 'Портокалова кора',
  'Citrus Aurantium Bergamia Fruit Oil': 'Масло от бергамот',
  'Citrus Bergamia Fruit Oil': 'Масло от бергамот',
  'Citrus Paradisi Peel Oil': 'Масло от грейпфрут',
  'Citrus Aurantifolia Oil': 'Масло от лайм',
  'Eucalyptus Globulus Leaf Oil': 'Евкалипт',
  'Lavandula Angustifolia Oil': 'Лавандулово масло',
  'Lavandula Angustifolia Flower': 'Лавандула',
  'Litsea Cubeba Fruit Oil': 'Май Чанг',
  'Calendula Officinalis Flower': 'Невен',
  'Mentha Viridis Leaf Oil': 'Къдрава мента',
  'Mentha Arvensis Leaf Oil': 'Полска мента',
  'Mentha Piperita Leaf': 'Лютива мента',
  'Mentha Piperita Oil': 'Масло от мента',
  'Cymbopogon Flexuosus Oil': 'Лимонена трева',
  'Cymbopogon Citratus Leaf': 'Лимонена трева',
  'Cymbopogon Citratus Leaf Oil': 'Масло от лимонена трева',
  'Pelargonium Graveolens Flower Oil': 'Масло от здравец',
  'Piper Nigrum Fruit Oil': 'Масло от черен пипер',
  'Rosmarinus Officinalis Leaf': 'Розмарин',
  'Rosmarinus Officinalis Leaf Oil': 'Масло от розмарин',
  'Abies Sibirica Needle Oil': 'Масло от сибирска ела',
  'Camellia Sinensis Leaf': 'Зелен чай',
  'Chamomilla Recutita Flower': 'Лайка',
  'Centaurea Cyanus Flower': 'Метличина',
  'Hibiscus Sabdariffa Flower': 'Хибискус',
  'Clitoria Ternatea Flower': 'Пеперудено цвете',
  'Cinnamomum Zeylanicum Bark Powder': 'Цейлонска канела',
  'Zingiber Officinale Root Powder': 'Джинджифил',
  'Theobroma Cacao Shell Powder': 'Черупки от какаови зърна',
  'Avena Sativa Kernel Flour': 'Овесени ядки',
  'Cocos Nucifera Flour': 'Кокос',
};

const BG_FOOTNOTE = '* Естествено срещащи се в етеричните масла.';

// ---- rewriting ------------------------------------------------------------

/** Every "Term (gloss)" pair in a value, longest term first so the match is exact. */
const TERM_RE = /([A-Za-z][A-Za-z0-9\-À-ɏ]*(?:[ \-][A-Za-z0-9\-À-ɏ]+){0,4})(\s*)\(([^()]*)\)/g;

function applyFixes(value, locale) {
  let out = value.replace(TERM_RE, (whole, term, space, gloss) => {
    const t = term.trim();
    const renamed = TERM_FIXES[locale]?.[t];
    const fixed = FIXES[t]?.[locale]?.[gloss.trim()] ?? FIXES[renamed]?.[locale]?.[gloss.trim()];
    if (!renamed && !fixed) return whole;
    return `${renamed ?? t}${space}(${fixed ?? gloss})`;
  });
  // A local-language INCI name with no gloss after it.
  for (const [wrong, right] of Object.entries(TERM_FIXES[locale] ?? {})) {
    out = out.replaceAll(wrong, right);
  }
  return out;
}

const latinTerms = (value) =>
  [...value.replace(/<[^>]+>/g, ' ').matchAll(TERM_RE)].map((m) => m[1].trim());

/** Bulgarian lists written back to front get rebuilt from the Slovak one. */
function rebuildBulgarian(skValue) {
  const missing = new Set();
  const value = skValue.replace(TERM_RE, (whole, term, space, gloss) => {
    const t = term.trim();
    if (!BG[t]) { missing.add(t); return whole; }
    return `${t}${space}(${BG[t]})`;
  }).replace(/\*[^*<]*v esenciálnych olejoch\./g, BG_FOOTNOTE);
  return { value, missing: [...missing] };
}

// ---- Shopify --------------------------------------------------------------

const PRODUCTS = `query P($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id handle status zl: metafield(namespace: "custom", key: "zlozenie") { id value } }
  }
}`;

const SET_METAFIELD = `mutation M($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
}`;

const REGISTER = `mutation T($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations { locale } userErrors { field message }
  }
}`;

async function shopLocales(store) {
  const d = await graphql(store, '{ shopLocales { locale primary } }');
  return {
    primary: d.shopLocales.find((l) => l.primary).locale,
    secondary: d.shopLocales.filter((l) => !l.primary).map((l) => l.locale),
  };
}

async function digestOf(store, metafieldId) {
  const d = await graphql(store, `query($id: ID!) {
    translatableResource(resourceId: $id) { translatableContent { key digest } }
  }`, { id: metafieldId });
  return d.translatableResource?.translatableContent?.find((c) => c.key === 'value')?.digest;
}

async function translationOf(store, metafieldId, locale) {
  const d = await graphql(store, `query($id: ID!, $l: String!) {
    translatableResource(resourceId: $id) { translations(locale: $l) { key value } }
  }`, { id: metafieldId, l: locale });
  return d.translatableResource?.translations?.find((t) => t.key === 'value')?.value ?? null;
}

// ---- run ------------------------------------------------------------------

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyStore = args.find((a) => a.startsWith('--store='))?.slice('--store='.length);
const onlyLocale = args.find((a) => a.startsWith('--locale='))?.slice('--locale='.length);

console.log(apply ? '*** APPLY — writing to Shopify ***\n' : 'dry run — nothing will be written\n');

/** Show just the lines that change, so a diff of 40 products stays readable. */
function printDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) console.log(`        - ${a[i].trim().slice(0, 150)}`);
    if (b[i] !== undefined) console.log(`        + ${b[i].trim().slice(0, 150)}`);
  }
}

let changed = 0;
let written = 0;
const gaps = new Set();

for (const store of STORES.filter((s) => !onlyStore || s === onlyStore)) {
  const { primary, secondary } = await shopLocales(store);
  const products = (await paginate(store, PRODUCTS, (d) => d.products, { pageSize: 50 }))
    .filter((p) => p.zl?.value);
  console.log(`########## ${store.toUpperCase()} — ${products.length} produktov so zložením\n`);

  for (const p of products) {
    const edits = [];

    // The store's own language.
    if (!onlyLocale || onlyLocale === primary) {
      const next = applyFixes(p.zl.value, primary);
      if (next !== p.zl.value) edits.push({ locale: primary, primary: true, before: p.zl.value, after: next });
    }

    for (const locale of secondary.filter((l) => !onlyLocale || l === onlyLocale)) {
      const current = await translationOf(store, p.zl.id, locale);
      if (!current) continue;

      let next = applyFixes(current, locale);

      // Bulgarian entries with no Latin INCI at all are rebuilt, not patched.
      if (locale === 'bg' && latinTerms(current).length < latinTerms(p.zl.value).length) {
        const rebuilt = rebuildBulgarian(applyFixes(p.zl.value, primary));
        rebuilt.missing.forEach((m) => gaps.add(m));
        next = rebuilt.value;
      }

      if (next !== current) edits.push({ locale, primary: false, before: current, after: next });
    }

    if (!edits.length) continue;
    changed++;
    console.log(`=== ${p.handle} [${p.status}]`);

    for (const e of edits) {
      console.log(`   ${e.locale}${e.primary ? ' (vlastný jazyk)' : ''}`);
      printDiff(e.before, e.after);

      if (!apply) continue;
      if (e.primary) {
        const res = await graphql(store, SET_METAFIELD, {
          metafields: [{
            ownerId: p.id, namespace: 'custom', key: 'zlozenie',
            type: 'multi_line_text_field', value: e.after,
          }],
        });
        const errs = res.metafieldsSet.userErrors;
        if (errs.length) console.log(`      ✗ ${JSON.stringify(errs)}`);
        else written++;
      } else {
        // The digest pins a translation to the source text, and editing the
        // source changes it — so read it after any primary-language write.
        const digest = await digestOf(store, p.zl.id);
        const res = await graphql(store, REGISTER, {
          resourceId: p.zl.id,
          translations: [{ locale: e.locale, key: 'value', value: e.after, translatableContentDigest: digest }],
        });
        const errs = res.translationsRegister.userErrors;
        if (errs.length) console.log(`      ✗ ${JSON.stringify(errs)}`);
        else written++;
      }
    }
    console.log();
  }
}

if (gaps.size) {
  console.log(`! bez bulharského prekladu (ponechané v latinke): ${[...gaps].join(', ')}\n`);
}
console.log(apply
  ? `Done. ${changed} produkt(ov), ${written} zápis(ov).`
  : `Dry run complete. ${changed} produkt(ov) by sa zmenilo. Re-run with --apply.`);
