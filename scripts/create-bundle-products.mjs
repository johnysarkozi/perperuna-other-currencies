#!/usr/bin/env node
/**
 * Creates the three multipack products on SK, as drafts.
 *
 *   node scripts/create-bundle-products.mjs            # dry run
 *   node scripts/create-bundle-products.mjs --apply    # create them
 *   node scripts/create-bundle-products.mjs --apply --only=PP-NUBE-NEDO-035
 *
 * Dry run is the default. The definitions below are the source of truth for
 * what these products are — copy, SKU, price, media, metafields — so a rerun
 * after an edit is reviewable as a diff rather than as clicking through an
 * admin.
 *
 * Deliberately SK only. Once the copy is settled the same shape gets
 * translated per market; nothing here writes to CZ/RO/PL/HU.
 *
 * Re-running is safe: a handle that already exists is reported and skipped
 * rather than duplicated.
 */

import { graphql } from '../lib/shopify.mjs';

const STORE = 'sk';
const CDN = 'https://cdn.shopify.com/s/files/1/0914/4500/2567/files';

// ---- shared building blocks ----------------------------------------------

const COLLECTIONS = [
  'gid://shopify/Collection/658595807559', // all-products
  'gid://shopify/Collection/659469435207', // kocky
  'gid://shopify/Collection/661238743367', // all
];
// frontpage is left out on purpose — these are drafts, and the homepage
// selection is a merchandising call to make when they go live.

const MO = {
  navodKocky: 'gid://shopify/Metaobject/506747879751',
  benefitSety: 'gid://shopify/Metaobject/506747420999',
  uplift: 'gid://shopify/Metaobject/506746667335',
  breathe: 'gid://shopify/Metaobject/506746700103',
  balance: 'gid://shopify/Metaobject/506746732871',
  calm: 'gid://shopify/Metaobject/506746765639',
  refresh: 'gid://shopify/Metaobject/506746798407',
};

/** Benefits of all five scents, plus the generic "what aromatherapy does" block. */
const BENEFITY_5 = [MO.benefitSety, MO.uplift, MO.breathe, MO.balance, MO.calm, MO.refresh];

/** The cube FAQ, exactly as it hangs on the single cubes. */
const FAQ = [
  '506755481927', '506755514695', '506755547463', '506755612999', '506755645767',
  '506755678535', '506755711303', '506755744071', '506755776839',
].map((id) => `gid://shopify/Metaobject/${id}`);

/** Reviews shown on the ritual set — set-level reviews, not scent-specific. */
const RECENZIE = [
  '507551220039', '507551252807', '507551056199', '507551088967', '507550695751', '507550499143',
].map((id) => `gid://shopify/Metaobject/${id}`);

const FOOTNOTE = `<br><span style='font-size:13px;opacity:.75'>* prirodzene sa vyskytujúce v esenciálnych olejoch.</span>`;

const ingredientsBlock = (name, inci) =>
  `<div class="pp-ingredients-block">\n<h4>${name}</h4>\n<p>\n${inci}\n${FOOTNOTE}\n</p>\n</div>`;

/**
 * Ingredient lists for the five scents.
 *
 * Uplift, Breathe, Balance and Calm are copied verbatim from the single-cube
 * products. Refresh is transcribed from the printed box artwork ("SINGLE BOXY
 * EN fin.pdf", batch P260516AF), because the Refresh cube carries no
 * custom.zlozenie on SK — the label is the authoritative source, not the site.
 */
const INCI = {
  refresh:
    'Sodium Bicarbonate (Jedlá sóda), Citric Acid (Kyselina citrónová), Zea Mays Starch (Kukuričný škrob), Aqua (Voda),\n' +
    'Maranta Arundinacea Root Powder (Arorut), Cymbopogon Flexuosus Oil (Citrónová tráva), Menthol (Mentol),\n' +
    'Citrus Aurantifolia Oil (Limetkový olej), Mentha Viridis Leaf Oil (Mäta kučeravá), CI 19140, CI 42090,\n' +
    'Citral*, Limonene*, Geraniol*, Linalool*',
};

const ZLOZENIE_5 = '<div class="pp-ingredients-card">' + [
  ingredientsBlock('Uplift',
    'Sodium Bicarbonate (Jedlá sóda), Citric Acid (Kyselina citrónová), Zea Mays Starch (Kukuričný škrob), Aqua (Voda),\n' +
    'Citrus Limon Peel Oil (Citrónový olej), Eucalyptus Globulus Leaf Oil (Eukalyptus),\n' +
    'Maranta Arundinacea Root Powder (Arorut), Calendula Officinalis Flower (Nechtík lekársky),\n' +
    'Mentha Viridis Leaf Oil (Mäta kučeravá), Menthol (Mentol), CI 19140,\n' +
    'Limonene*, Pinene*, Carvone*, Citral*'),
  ingredientsBlock('Breathe',
    'Sodium Bicarbonate (Jedlá sóda), Citric Acid (Kyselina citrónová), Zea Mays Starch (Kukuričný škrob), Aqua (Voda),\n' +
    'Mentha Arvensis Leaf Oil (Mäta roľná), Eucalyptus Globulus Leaf Oil (Eukalyptus),\n' +
    'Maranta Arundinacea Root Powder (Arorut), Menthol (Mentol), Mentha Piperita Leaf (Mäta pieporná),\n' +
    'Limonene*, Pinene*, Beta-Caryophyllene*, Terpineol*'),
  ingredientsBlock('Balance',
    'Sodium Bicarbonate (Jedlá sóda), Citric Acid (Kyselina citrónová), Zea Mays Starch (Kukuričný škrob), Aqua (Voda),\n' +
    'Citrus Aurantium Dulcis Peel Oil (Pomarančový olej), Citrus Aurantium Bergamia Fruit Oil (Bergamotový olej),\n' +
    'Litsea Cubeba Fruit Oil (May Chang), Maranta Arundinacea Root Powder (Arorut), CI 15985,\n' +
    'Limonene*, Citral*, Linalyl Acetate*, Linalool*, Pinene*, Beta-Caryophyllene*, Geraniol*, Citronellol*'),
  ingredientsBlock('Calm',
    'Sodium Bicarbonate (Jedlá sóda), Citric Acid (Kyselina citrónová), Zea Mays Starch (Kukuričný škrob), Aqua (Voda),\n' +
    'Lavandula Angustifolia Oil (Levanduľový olej), Citrus Nobilis Peel Oil (Mandarínkový olej),\n' +
    'Maranta Arundinacea Root Powder (Arorut),\n' +
    'Limonene*, Linalool*, Linalyl Acetate*, Pinene*, Geraniol*'),
  ingredientsBlock('Refresh', INCI.refresh),
].join('') + '</div>';

/** The explainer graphics every cube product carries, in the usual order. */
const SHARED_GRAPHICS = [
  ['Frame_78.png', 'Ako sa sprchová kocka používa'],
  ['6_141c07fb-0f2f-4ffc-9dfd-33efc3f8f952.png', 'Prírodné zloženie bez zbytočnej chémie'],
  ['2_5ce6dce1-76fa-460e-a015-012795798d48.png', 'Sprchová kocka v akcii'],
  ['4_1d0b9d4d-bd07-4cae-9f03-759b923f0fb4.png', 'Vôňa, ktorá vydrží celú sprchu'],
  ['7_a52717ff-18ce-4c30-b960-12ae6ddce79e.png', 'Vyrobené na Slovensku'],
];

const media = (pairs) => pairs.map(([file, alt]) => ({
  mediaContentType: 'IMAGE',
  originalSource: `${CDN}/${file}`,
  alt,
}));

const specCard = ({ intro, rows, note }) => `<div class="pp-spec-card">
<div class="pp-spec-intro">${intro}</div>
<dl>
${rows.map(([dt, dd]) => `<dt>${dt}</dt>\n<dd>${dd}</dd>`).join('\n')}
</dl>
<div class="pp-inline-info">
<span class="pp-info-icon">i</span>${note}</div>
</div>`;

const SCENTS = 'Uplift · Breathe · Balance · Calm · Refresh';

// ---- the three products ---------------------------------------------------

const PRODUCTS = [
  {
    sku: 'PP-RSET-BUND-025',
    handle: 'discovery-set-5-kociek-a-kamenna-miska',
    title: 'Discovery set – 5 sprchových kociek + kamenná miska',
    price: '39.99',
    // 5 × 7.99 + 19.99 — the sum of what the parts cost separately.
    compareAtPrice: '59.94',
    weightGrams: 550, // 5 × 70 g + 170 g miska + balenie
    tags: ['_alt_bundle', 'bundle'],
    heroLabel: 'UŠETRI 33 %',
    seoDescription:
      'Všetkých päť vôní naraz a kamenná miska, ktorá z nich spraví rituál. Uplift, Breathe, Balance, Calm aj Refresh v jednom sete.',
    description: specCard({
      intro: 'Všetkých päť vôní naraz — a kamenná miska, ktorá z nich spraví rituál. ' +
        'Nemusíš hádať, ktorá vôňa je tá tvoja: vyskúšaš každú a necháš sa viesť náladou. ' +
        'Uplift na rozbeh dňa, Breathe na nadýchnutie, Balance na stíšenie, Calm na večer a Refresh, keď potrebuješ reset.',
      rows: [
        ['Obsah', '5 sprchových kociek (1× každá vôňa) a kamenná miska'],
        ['Kompozícia vôní', SCENTS],
        ['Ideálny moment', 'Keď s kockami začínaš — alebo keď hľadáš darček, pri ktorom sa netrafíš vedľa.'],
      ],
      note: 'Jedna kocka ti dopraje až 3 sprchy, z celého setu máš približne 15 sprch.',
    }),
    media: media([
      ['5_plus_5_a_miska_2.jpg', 'Discovery set – päť sprchových kociek a kamenná miska'],
      ['krabicky_bundle_novy_gr.png', 'Päť krabičiek sprchových kociek'],
      ['miska_1_gr.png', 'Kamenná miska na sprchový rituál'],
      ['3.png', 'Päť vôní sprchových kociek'],
      ...SHARED_GRAPHICS,
    ]),
    metafields: [
      { namespace: 'custom', key: 'zlozenie', type: 'multi_line_text_field', value: ZLOZENIE_5 },
      { namespace: 'custom', key: 'benefity', type: 'list.metaobject_reference', value: JSON.stringify(BENEFITY_5) },
      { namespace: 'custom', key: 'navod', type: 'metaobject_reference', value: MO.navodKocky },
      { namespace: 'custom', key: 'faq', type: 'list.metaobject_reference', value: JSON.stringify(FAQ) },
      { namespace: 'custom', key: 'recenzie', type: 'list.metaobject_reference', value: JSON.stringify(RECENZIE) },
    ],
  },

  {
    sku: 'PP-CUBE-BUND-034',
    handle: '10-sprchovych-kociek-2x-kazda-vona',
    title: '10 sprchových kociek – 2× každá vôňa',
    price: '44.99',
    compareAtPrice: '79.90', // 10 × 7.99
    weightGrams: 730, // 10 × 70 g + balenie
    tags: ['_alt_kocky', 'kocka'],
    heroLabel: 'UŠETRI 44 %',
    seoDescription:
      'Desať sprchových kociek, dve od každej vône. Zásoba, pri ktorej nemusíš vyberať ani dokupovať.',
    description: specCard({
      intro: 'Desať kociek, dve od každej vône. Nemusíš vyberať a nemusíš dokupovať — ' +
        'ráno siahneš po Uplifte, večer po Calme a vždy máš doma ešte jednu do zálohy. ' +
        'Najvýhodnejší spôsob, ako mať celú kolekciu poruke.',
      rows: [
        ['Obsah', '10 sprchových kociek (2× každá vôňa)'],
        ['Kompozícia vôní', SCENTS],
        ['Ideálny moment', 'Keď už vieš, že ti kocky sadli, a nechceš, aby ti došli.'],
      ],
      note: 'Jedna kocka ti dopraje až 3 sprchy, z celého balenia máš približne 30 sprch.',
    }),
    media: media([
      ['krabicky_bundle_novy_gr.png', 'Desať sprchových kociek – dve od každej vône'],
      ['5_plus_5_a_miska_2.jpg', 'Sprchové kocky vo všetkých piatich vôňach'],
      ['3.png', 'Päť vôní sprchových kociek'],
      ['25.png', 'Sprchová kocka zblízka'],
      ...SHARED_GRAPHICS,
    ]),
    metafields: [
      { namespace: 'custom', key: 'zlozenie', type: 'multi_line_text_field', value: ZLOZENIE_5 },
      { namespace: 'custom', key: 'benefity', type: 'list.metaobject_reference', value: JSON.stringify(BENEFITY_5) },
      { namespace: 'custom', key: 'navod', type: 'metaobject_reference', value: MO.navodKocky },
      { namespace: 'custom', key: 'faq', type: 'list.metaobject_reference', value: JSON.stringify(FAQ) },
      { namespace: 'custom', key: 'recenzie', type: 'list.metaobject_reference', value: JSON.stringify(RECENZIE) },
    ],
  },

  {
    sku: 'PP-NUBE-NEDO-035',
    handle: '10-nedokonalych-sprchovych-kociek',
    title: '10 nedokonalých sprchových kociek',
    price: '31.96',
    compareAtPrice: '79.90', // 10 × 7.99, same reference the single seconds use
    weightGrams: 730,
    tags: ['_alt_kocky', 'kocka'],
    templateSuffix: 'nedokonale-kocky',
    heroLabel: 'UŠETRI 60 %',
    seoDescription:
      'Krivý roh, prasklina, odštiepok — nič, čo by cítil nos. Desať nedokonalých sprchových kociek za 60 % z ceny.',
    description: specCard({
      intro: 'Krivý roh, prasklina, odštiepok. Nič, čo by cítil nos — tieto kocky sa len nezmestili ' +
        'do krabičky s dokonalými. Voňajú rovnako, vydržia rovnako a sú o 60 % lacnejšie. ' +
        'Ideálne, keď kocky používaš každý deň a nemáš potrebu riešiť, ako vyzerajú.',
      rows: [
        ['Obsah', '10 nedokonalých sprchových kociek, mix vôní'],
        ['Kompozícia vôní', `Mix z ${SCENTS}. Zloženie balenia sa líši podľa toho, čo práve máme.`],
        ['Prečo sú lacnejšie', 'Majú kozmetickú vadu — prasklinu, odštiepený roh alebo nerovný povrch. Zloženie aj vôňa sú rovnaké ako pri bežných kockách.'],
      ],
      note: 'Jedna kocka ti dopraje až 3 sprchy, z celého balenia máš približne 30 sprch.',
    }),
    media: media([
      ['kocky_prasknute_2.png', 'Nedokonalé sprchové kocky s prasklinami'],
      ['52_12d55ac8-ab1c-476f-bc05-98dc401ca8b5.png', 'Nedokonalá sprchová kocka zblízka'],
      ['25.png', 'Sprchová kocka zblízka'],
      ['3_022697c1-0aec-4f31-b539-24f326491adf.png', 'Nedokonalé kocky v mixe vôní'],
      ...SHARED_GRAPHICS,
    ]),
    metafields: [
      { namespace: 'custom', key: 'zlozenie', type: 'multi_line_text_field', value: ZLOZENIE_5 },
      { namespace: 'custom', key: 'benefity', type: 'list.metaobject_reference', value: JSON.stringify(BENEFITY_5) },
      { namespace: 'custom', key: 'navod', type: 'metaobject_reference', value: MO.navodKocky },
      { namespace: 'custom', key: 'faq', type: 'list.metaobject_reference', value: JSON.stringify(FAQ) },
      { namespace: 'custom', key: 'promo', type: 'single_line_text_field', value: 'NEDOKONALÉ. <br> ROVNAKO VOŇAVÉ.' },
      { namespace: 'custom', key: 'hero_label_bottom', type: 'single_line_text_field', value: 'NEDOKONALÉ. <br> ROVNAKO VOŇAVÉ.' },
    ],
  },
];

/**
 * Starting stock. These sets are tracked separately from their components —
 * that is how every existing bundle on SK works — so the number here is a
 * placeholder in the same range as the other sets, to be corrected in the
 * dashboard before the products go live.
 */
const START_QUANTITY = 500;

/**
 * Metafields that belong on products this script did not create. Applied by
 * --sync-metafields, so the ingredient text has one home rather than being
 * pasted into an admin and drifting.
 */
const EXTRA_METAFIELDS = [
  {
    handle: 'refresh-sprchova-aromaticka-kocka',
    metafields: [{
      namespace: 'custom',
      key: 'zlozenie',
      type: 'multi_line_text_field',
      // The single cubes carry a plain list, not the multi-scent card.
      value: `${INCI.refresh}\n* prirodzene sa vyskytujúce v esenciálnych olejoch.`,
    }],
  },
];

// ---- writing --------------------------------------------------------------

const CREATE = `mutation C($input: ProductInput!, $media: [CreateMediaInput!]) {
  productCreate(input: $input, media: $media) {
    product { id handle status variants(first: 1) { nodes { id } } }
    userErrors { field message }
  }
}`;

const VARIANT = `mutation V($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id sku price compareAtPrice }
    userErrors { field message }
  }
}`;

const SET_QTY = `mutation Q($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) { userErrors { field message code } }
}`;

async function existingHandle(handle) {
  const d = await graphql(STORE, `query($h: String!) { productByHandle(handle: $h) { id status } }`, { h: handle });
  return d.productByHandle;
}

async function primaryLocation() {
  const d = await graphql(STORE, '{ locations(first: 10) { nodes { id name isActive } } }');
  const active = d.locations.nodes.filter((l) => l.isActive);
  if (active.length !== 1) throw new Error(`expected one active location, found ${active.length}`);
  return active[0];
}

const SET_METAFIELDS = `mutation M($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { key }
    userErrors { field message }
  }
}`;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

/**
 * Re-apply the declared metafields to products that already exist, for when
 * copy or an ingredient list changes after creation.
 */
if (args.includes('--sync-metafields')) {
  const targets = [
    ...PRODUCTS.map((p) => ({ handle: p.handle, metafields: p.metafields })),
    ...EXTRA_METAFIELDS,
  ];
  console.log(`store: ${STORE.toUpperCase()}   ${apply ? '*** APPLY ***' : 'dry run'}   sync metafields\n`);

  for (const t of targets) {
    const product = await existingHandle(t.handle);
    const keys = t.metafields.map((m) => `${m.namespace}.${m.key}`).join(', ');
    console.log(`=== ${t.handle}${product ? '' : '  !! neexistuje — preskakujem'}`);
    console.log(`    ${keys}`);
    if (!product || !apply) { console.log(); continue; }

    const res = await graphql(STORE, SET_METAFIELDS, {
      metafields: t.metafields.map((m) => ({ ...m, ownerId: product.id })),
    });
    const errs = res.metafieldsSet.userErrors;
    console.log(errs.length ? `    ✗ ${JSON.stringify(errs)}\n` : `    ✓ ${res.metafieldsSet.metafields.length} zapísaných\n`);
  }
  process.exit(0);
}

const wanted = only ? PRODUCTS.filter((p) => p.sku === only) : PRODUCTS;

if (!wanted.length) {
  console.error(`No product matches --only=${only}. Known: ${PRODUCTS.map((p) => p.sku).join(', ')}`);
  process.exit(1);
}

console.log(`store: ${STORE.toUpperCase()}   ${apply ? '*** APPLY — writing to Shopify ***' : 'dry run — nothing will be written'}\n`);

const location = apply ? await primaryLocation() : null;
let created = 0;

for (const p of wanted) {
  const clash = await existingHandle(p.handle);
  console.log(`=== ${p.sku}  ${p.title}`);
  console.log(`    handle    ${p.handle}${clash ? `  !! už existuje (${clash.status}) — preskakujem` : ''}`);
  console.log(`    cena      ${p.price} € (pôvodne ${p.compareAtPrice} €, ${p.heroLabel})`);
  console.log(`    hmotnosť  ${p.weightGrams} g   stav DRAFT   sklad ${START_QUANTITY}`);
  console.log(`    médiá     ${p.media.length}   metafieldy ${p.metafields.length}   kolekcie ${COLLECTIONS.length}`);
  if (clash) { console.log(); continue; }
  if (!apply) { console.log(); continue; }

  const res = await graphql(STORE, CREATE, {
    input: {
      title: p.title,
      handle: p.handle,
      descriptionHtml: p.description,
      status: 'DRAFT',
      tags: p.tags,
      ...(p.templateSuffix ? { templateSuffix: p.templateSuffix } : {}),
      collectionsToJoin: COLLECTIONS,
      seo: { title: `${p.title} | PERPERUNA`, description: p.seoDescription },
      metafields: [
        ...p.metafields,
        { namespace: 'custom', key: 'hero_label', type: 'single_line_text_field', value: p.heroLabel },
      ],
    },
    media: p.media,
  });
  const errs = res.productCreate.userErrors;
  if (errs.length) { console.log(`    ✗ productCreate: ${JSON.stringify(errs)}\n`); continue; }

  const product = res.productCreate.product;
  const variantId = product.variants.nodes[0].id;

  const vr = await graphql(STORE, VARIANT, {
    productId: product.id,
    variants: [{
      id: variantId,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      inventoryItem: {
        sku: p.sku,
        tracked: true,
        requiresShipping: true,
        measurement: { weight: { value: p.weightGrams, unit: 'GRAMS' } },
      },
    }],
  });
  const verrs = vr.productVariantsBulkUpdate.userErrors;
  if (verrs.length) { console.log(`    ✗ variant: ${JSON.stringify(verrs)}\n`); continue; }

  const inv = await graphql(STORE, `query($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`, { id: variantId });
  const qr = await graphql(STORE, SET_QTY, {
    input: {
      reason: 'correction',
      name: 'available',
      referenceDocumentUri: `gid://perperuna-catalog/ProductCreate/${p.sku}`,
      ignoreCompareQuantity: true,
      quantities: [{ inventoryItemId: inv.productVariant.inventoryItem.id, locationId: location.id, quantity: START_QUANTITY }],
    },
  });
  const qerrs = qr.inventorySetQuantities.userErrors;
  if (qerrs.length) console.log(`    ! sklad sa nenastavil: ${JSON.stringify(qerrs)}`);

  created++;
  console.log(`    ✓ vytvorené — ${product.id}\n`);
}

console.log(apply
  ? `Done. ${created}/${wanted.length} produkt(ov) vytvorených ako DRAFT.`
  : `Dry run complete. Re-run with --apply to create.`);
