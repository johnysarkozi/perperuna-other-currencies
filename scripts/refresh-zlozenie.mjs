#!/usr/bin/env node
/**
 * Puts the Refresh ingredient list everywhere it belongs, in every language.
 *
 *   node scripts/refresh-zlozenie.mjs           # dry run
 *   node scripts/refresh-zlozenie.mjs --apply   # write
 *
 * Two jobs:
 *
 *   1. The Refresh cube (PP-CUBE-REFR-033) carries no custom.zlozenie on any
 *      backend. Fill it in each store's own language, and on SK also as a
 *      translation for each of the nine secondary locales.
 *
 *   2. The three SK multipacks show a five-scent ingredient card. Their SK
 *      value already has all five blocks; the other nine locales have no
 *      translation of the card at all. Build one per locale by reusing the
 *      wording already approved on the single cubes, and appending Refresh.
 *
 * The per-scent text for Uplift/Breathe/Balance/Calm is read live from the
 * single cubes rather than copied here, so editing a cube's ingredients and
 * re-running keeps the sets in step.
 *
 * Refresh itself is transcribed from the printed box artwork ("SINGLE BOXY EN
 * fin.pdf", batch P260516AF). Glosses and footnotes follow the wording already
 * used on the other four scents in that language, including its quirks — an
 * ingredient card that switches style halfway down reads as a mistake.
 */

import { graphql } from '../lib/shopify.mjs';

const REFRESH_SKU = 'PP-CUBE-REFR-033';

/** Cubes whose existing translations supply the wording for the set cards. */
const SOURCE_CUBES = [
  ['Uplift', 'sprchova-aromaticka-kocka-uplift'],
  ['Breathe', 'sprchova-aromaticka-kocka-breathe'],
  ['Balance', 'sprchova-aromaticka-kocka-balance'],
  ['Calm', 'sprchova-aromaticka-kocka-calm'],
];

/** The SK multipacks that show the five-scent card. */
const SET_HANDLES = [
  'discovery-set-5-kociek-a-kamenna-miska',
  '10-sprchovych-kociek-2x-kazda-vona',
  '10-nedokonalych-sprchovych-kociek',
];

/**
 * Refresh, per language. Line breaks match the shape used on the other cubes.
 * Where a language leaves a gloss untranslated on the existing cubes
 * ("Aqua (Voda)", "(Arorut)", "(Mentol)"), that is reproduced here on purpose.
 */
const REFRESH = {
  sk: `Sodium Bicarbonate (Jedlá sóda), Citric Acid (Kyselina citrónová), Zea Mays Starch (Kukuričný škrob), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (Citrónová tráva), Menthol (Mentol),
Citrus Aurantifolia Oil (Limetkový olej), Mentha Viridis Leaf Oil (Mäta kučeravá), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* prirodzene sa vyskytujúce v esenciálnych olejoch.`,

  cs: `Sodium Bicarbonate (Jedlá soda), Citric Acid (Kyselina citronová), Zea Mays Starch (Kukuřičný škrob), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (Citronová tráva), Menthol (Mentol),
Citrus Aurantifolia Oil (Limetkový olej), Mentha Viridis Leaf Oil (Máta kadeřavá), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* přirozeně se vyskytující v esenciálních olejích.`,

  ro: `Sodium Bicarbonate (Bicarbonat de sodiu), Citric Acid (Acid citric), Zea Mays Starch (Amidon de porumb), Aqua (Apă),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (Iarbă de lămâie), Menthol (Mentol),
Citrus Aurantifolia Oil (Ulei de lime), Mentha Viridis Leaf Oil (Mentă creață), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* prezente în mod natural în uleiurile esențiale.`,

  pl: `Sodium Bicarbonate (Soda oczyszczona), Citric Acid (Kwas cytrynowy), Zea Mays Starch (Skrobia kukurydziana), Aqua (Woda),
Maranta Arundinacea Root Powder (Arrowroot), Cymbopogon Flexuosus Oil (Trawa cytrynowa), Menthol (Mentol),
Citrus Aurantifolia Oil (Olejek limonkowy), Mentha Viridis Leaf Oil (Mięta kędzierzawa), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* naturalnie występujące w olejkach eterycznych.`,

  hu: `Sodium Bicarbonate (Szódabikarbóna), Citric Acid (Citromsav), Zea Mays Starch (Kukoricakeményítő), Aqua (Víz),
Maranta Arundinacea Root Powder (Nyílgyökér), Cymbopogon Flexuosus Oil (Citromfű), Menthol (Mentol),
Citrus Aurantifolia Oil (Lime olaj), Mentha Viridis Leaf Oil (Fodormenta), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* természetesen előfordulnak az illóolajokban.`,

  de: `Sodium Bicarbonate (Natriumbicarbonat), Citric Acid (Zitronensäure), Zea Mays Starch (Maisstärke), Aqua (Wasser),
Maranta Arundinacea Root Powder (Pfeilwurz), Cymbopogon Flexuosus Oil (Zitronengras), Menthol (Menthol),
Citrus Aurantifolia Oil (Limettenöl), Mentha Viridis Leaf Oil (Grüne Minze), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
*natürlich in ätherischen Ölen vorkommend.`,

  en: `Sodium Bicarbonate (baking soda), Citric Acid (citric acid), Zea Mays Starch (corn starch), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (lemongrass), Menthol (Mentol),
Citrus Aurantifolia Oil (lime oil), Mentha Viridis Leaf Oil (spearmint), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* naturally occurring in essential oils.`,

  es: `Sodium Bicarbonate (bicarbonato de sodio), Citric Acid (ácido cítrico), Zea Mays Starch (almidón de maíz), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (hierba limón), Menthol (Mentol),
Citrus Aurantifolia Oil (aceite de lima), Mentha Viridis Leaf Oil (menta verde), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* presentes de forma natural en los aceites esenciales.`,

  fr: `Sodium Bicarbonate (bicarbonate de soude), Citric Acid (acide citrique), Zea Mays Starch (amidon de maïs), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (citronnelle), Menthol (Mentol),
Citrus Aurantifolia Oil (huile de citron vert), Mentha Viridis Leaf Oil (menthe verte), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* naturellement présents dans les huiles essentielles.`,

  hr: `Sodium Bicarbonate (soda bikarbona), Citric Acid (limunska kiselina), Zea Mays Starch (kukuruzni škrob), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (limunska trava), Menthol (Mentol),
Citrus Aurantifolia Oil (ulje limete), Mentha Viridis Leaf Oil (zelena metvica), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* prirodno prisutni u eteričnim uljima.`,

  it: `Sodium Bicarbonate (bicarbonato di sodio), Citric Acid (acido citrico), Zea Mays Starch (amido di mais), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (citronella), Menthol (Mentol),
Citrus Aurantifolia Oil (olio di lime), Mentha Viridis Leaf Oil (menta verde), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* naturalmente presenti negli oli essenziali.`,

  nl: `Sodium Bicarbonate (baksoda), Citric Acid (citroenzuur), Zea Mays Starch (maïszetmeel), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (citroengras), Menthol (Mentol),
Citrus Aurantifolia Oil (limoenolie), Mentha Viridis Leaf Oil (groene munt), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* van nature aanwezig in etherische oliën.`,

  sl: `Sodium Bicarbonate (soda bikarbona), Citric Acid (citronska kislina), Zea Mays Starch (koruzni škrob), Aqua (Voda),
Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (limonska trava), Menthol (Mentol),
Citrus Aurantifolia Oil (olje limete), Mentha Viridis Leaf Oil (zelena meta), CI 19140, CI 42090,
Citral*, Limonene*, Geraniol*, Linalool*
* naravno prisotni v eteričnih oljih.`,

  // Bulgarian transliterates the INCI names themselves on the existing cubes.
  bg: `Натриев бикарбонат (сода за хляб), лимонена киселина (лимонена киселина), царевично нишесте (царевично нишесте), аква (вода),
прах от корен на маранта арундинацея (арорут), масло от лимонена трева (лимонена трева), ментол (ментол),
масло от лайм (Citrus Aurantifolia Oil), масло от листа на Mentha Viridis (мента), CI 19140, CI 42090,
цитрал*, лимонен*, гераниол*, линалоол*
* Естествено срещащи се в етеричните масла.`,
};

// ---- shaping --------------------------------------------------------------

/** Split a plain ingredient list into its body and its trailing footnote. */
function splitFootnote(text) {
  const lines = text.trim().split('\n');
  const last = lines[lines.length - 1].trim();
  return last.startsWith('*')
    ? { body: lines.slice(0, -1).join('\n'), footnote: last }
    : { body: lines.join('\n'), footnote: '' };
}

const block = (name, text) => {
  const { body, footnote } = splitFootnote(text);
  return `<div class="pp-ingredients-block">\n<h4>${name}</h4>\n<p>\n${body}\n` +
    `<br><span style='font-size:13px;opacity:.75'>${footnote}</span>\n</p>\n</div>`;
};

const card = (blocks) => `<div class="pp-ingredients-card">${blocks.join('')}</div>`;

// ---- Shopify --------------------------------------------------------------

const REGISTER = `mutation T($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations { locale key }
    userErrors { field message }
  }
}`;

const SET_METAFIELD = `mutation M($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
}`;

async function locales(store) {
  const d = await graphql(store, '{ shopLocales { locale primary published } }');
  return {
    primary: d.shopLocales.find((l) => l.primary).locale,
    secondary: d.shopLocales.filter((l) => !l.primary).map((l) => l.locale),
  };
}

/** The metafield's id plus the digest a translation has to be pinned to. */
async function zlozenieHandle(store, productId) {
  const d = await graphql(store, `query($id: ID!) {
    product(id: $id) { metafield(namespace: "custom", key: "zlozenie") { id value } }
  }`, { id: productId });
  const mf = d.product.metafield;
  if (!mf) return null;

  const t = await graphql(store, `query($id: ID!) {
    translatableResource(resourceId: $id) { translatableContent { key digest } }
  }`, { id: mf.id });
  return { ...mf, digest: t.translatableResource?.translatableContent?.find((c) => c.key === 'value')?.digest };
}

async function translationOf(store, metafieldId, locale) {
  const d = await graphql(store, `query($id: ID!, $l: String!) {
    translatableResource(resourceId: $id) { translations(locale: $l) { key value } }
  }`, { id: metafieldId, l: locale });
  return d.translatableResource?.translations?.find((t) => t.key === 'value')?.value ?? null;
}

async function productsBySku(store, sku) {
  const d = await graphql(store, `query($q: String!) {
    productVariants(first: 20, query: $q) { nodes { sku product { id handle status } } }
  }`, { q: `sku:${sku}` });
  const seen = new Map();
  for (const v of d.productVariants.nodes) {
    if (v.sku?.trim() !== sku) continue;
    seen.set(v.product.id, v.product);
  }
  return [...seen.values()];
}

async function productByHandle(store, handle) {
  const d = await graphql(store, `query($h: String!) { productByHandle(handle: $h) { id handle status } }`, { h: handle });
  return d.productByHandle;
}

// ---- run ------------------------------------------------------------------

const apply = process.argv.includes('--apply');
console.log(apply ? '*** APPLY — writing to Shopify ***\n' : 'dry run — nothing will be written\n');

let writes = 0;

async function setMetafield(store, productId, value, label) {
  console.log(`    ${label}`);
  if (!apply) return;
  const res = await graphql(store, SET_METAFIELD, {
    metafields: [{
      ownerId: productId, namespace: 'custom', key: 'zlozenie',
      type: 'multi_line_text_field', value,
    }],
  });
  const errs = res.metafieldsSet.userErrors;
  if (errs.length) console.log(`      ✗ ${JSON.stringify(errs)}`);
  else { writes++; console.log('      ✓'); }
}

async function registerTranslations(store, resourceId, digest, entries, label) {
  console.log(`    ${label}: ${entries.map((e) => e.locale).join(', ')}`);
  if (!apply) return;
  if (!digest) { console.log('      ✗ chýba digest zdrojového textu'); return; }
  const res = await graphql(store, REGISTER, {
    resourceId,
    translations: entries.map((e) => ({
      locale: e.locale, key: 'value', value: e.value, translatableContentDigest: digest,
    })),
  });
  const errs = res.translationsRegister.userErrors;
  if (errs.length) console.log(`      ✗ ${JSON.stringify(errs)}`);
  else { writes += entries.length; console.log(`      ✓ ${res.translationsRegister.translations.length}`); }
}

// --- 1. the Refresh cube, on every backend --------------------------------

for (const store of ['sk', 'cz', 'ro', 'pl', 'hu']) {
  const { primary, secondary } = await locales(store);
  const products = await productsBySku(store, REFRESH_SKU);
  console.log(`=== ${store.toUpperCase()} — Refresh kocka (${products.length} produkt(ov), primárne ${primary})`);

  const text = REFRESH[primary];
  if (!text) { console.log(`    ! nemám text pre jazyk ${primary} — preskakujem\n`); continue; }

  for (const p of products) {
    await setMetafield(store, p.id, text, `${p.handle} [${p.status}] — zloženie v ${primary}`);

    if (secondary.length) {
      const mf = await zlozenieHandle(store, p.id);
      const entries = secondary.filter((l) => REFRESH[l]).map((l) => ({ locale: l, value: REFRESH[l] }));
      const skipped = secondary.filter((l) => !REFRESH[l]);
      if (skipped.length) console.log(`    ! bez textu pre: ${skipped.join(', ')}`);
      if (entries.length) await registerTranslations(store, mf?.id, mf?.digest, entries, 'preklady');
    }
  }
  console.log();
}

// --- 2. the SK set cards, in every SK locale ------------------------------

const sk = await locales('sk');

// Harvest each scent's wording per locale from the single cubes.
const scentText = {}; // locale -> [[name, text], ...]
for (const [name, handle] of SOURCE_CUBES) {
  const p = await productByHandle('sk', handle);
  const mf = await zlozenieHandle('sk', p.id);
  (scentText[sk.primary] ??= []).push([name, mf.value]);
  for (const l of sk.secondary) {
    const v = await translationOf('sk', mf.id, l);
    if (v) (scentText[l] ??= []).push([name, v]);
  }
}

console.log('=== SK — karta piatich vôní na setoch');
for (const l of sk.secondary) {
  const have = scentText[l]?.length ?? 0;
  if (have < SOURCE_CUBES.length) console.log(`    ! ${l}: preložených len ${have}/${SOURCE_CUBES.length} vôní — kartu preskakujem`);
}

for (const handle of SET_HANDLES) {
  const p = await productByHandle('sk', handle);
  if (!p) { console.log(`    ! ${handle} neexistuje`); continue; }
  const mf = await zlozenieHandle('sk', p.id);
  console.log(`  ${handle} [${p.status}]`);

  const entries = sk.secondary
    .filter((l) => REFRESH[l] && scentText[l]?.length === SOURCE_CUBES.length)
    .map((l) => ({
      locale: l,
      value: card([
        ...scentText[l].map(([name, text]) => block(name, text)),
        block('Refresh', REFRESH[l]),
      ]),
    }));

  await registerTranslations('sk', mf?.id, mf?.digest, entries, 'preklady karty');
}

console.log(`\n${apply ? `Done. ${writes} zápis(ov).` : 'Dry run complete. Re-run with --apply to write.'}`);
