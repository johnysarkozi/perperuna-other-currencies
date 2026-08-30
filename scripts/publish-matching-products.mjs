#!/usr/bin/env node
/**
 * Zosúladí publikačný stav produktov medzi backendmi, keyed by SKU (rovnaká
 * logika párovania ako `catalog-pull.mjs`).
 *
 * Cieľ je presná zhoda so zdrojom — obojsmerne. Keď pribudne nový produkt na
 * SK a preklad naň nadväzujúca automatizácia založí na inom backende len ako
 * DRAFT bez publikácie do žiadneho kanála, skript ho doťahuje na ACTIVE. Rovnako
 * ale aj naopak: keď je zdrojový produkt zámerne UNLISTED (napr. vypredaný, tak
 * ho SK schovalo z vyhľadávania), cieľový produkt sa stiahne na rovnaký status
 * a odpublikuje z kanálov, ktoré zdroj nemá — nie je to len jednosmerné
 * „doťahovanie nahor".
 *
 * Nerieši obsah ani ceny, len či je produkt vôbec vidieť. Pri viacerých
 * produktoch so zhodnou množinou SKU (napr. plnocenná verzia vs. archivovaná
 * „-25%" duplicita) sa z oboch strán vyberie ten s najvyššou prioritou stavu
 * (ACTIVE > DRAFT > UNLISTED > ARCHIVED), nech sa nesplete akciová kópia
 * s hlavným produktom.
 *
 *   node scripts/publish-matching-products.mjs pl            # dry-run, zdroj sk
 *   node scripts/publish-matching-products.mjs pl --source sk --apply
 *   node scripts/publish-matching-products.mjs pl --handles a,b,c --apply   # len tieto cieľové handles
 */

import { paginate, graphql } from '../lib/shopify.mjs';

const STATUS_RANK = { ACTIVE: 0, DRAFT: 1, UNLISTED: 2, ARCHIVED: 3 };

const PRODUCTS = `query P($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status
      variants(first: 25) { nodes { sku } }
      resourcePublicationsV2(first: 10) { nodes { publication { id name } isPublished } }
    }
  }
}`;

const PUBLICATIONS = `{ publications(first: 10) { nodes { id name } } }`;

const PUBLISH = `mutation($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`;

const UNPUBLISH = `mutation($id: ID!, $input: [PublicationInput!]!) {
  publishableUnpublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`;

const STATUS_UPDATE = `mutation($id: ID!, $status: ProductStatus!) {
  productUpdate(product: { id: $id, status: $status }) {
    userErrors { field message }
  }
}`;

function skuKey(product) {
  const skus = product.variants.nodes.map((v) => v.sku).filter(Boolean);
  return skus.length ? skus.join(',') : null;
}

async function loadProducts(key) {
  const nodes = await paginate(key, PRODUCTS, (d) => d.products);
  const bySku = new Map();
  for (const p of nodes) {
    const sku = skuKey(p);
    if (!sku) continue;
    const existing = bySku.get(sku);
    if (!existing || STATUS_RANK[p.status] < STATUS_RANK[existing.status]) bySku.set(sku, p);
  }
  return bySku;
}

const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const sourceIdx = args.indexOf('--source');
const source = sourceIdx >= 0 ? args[sourceIdx + 1] : 'sk';
const handlesIdx = args.indexOf('--handles');
const onlyHandles = handlesIdx >= 0 ? new Set(args[handlesIdx + 1].split(',')) : null;
const target = args.find(
  (a, i) => !a.startsWith('--') && args[i - 1] !== '--source' && args[i - 1] !== '--handles',
);

if (!target) {
  console.error('použitie: node scripts/publish-matching-products.mjs <target> [--source sk] [--apply]');
  process.exit(1);
}

console.log(applyChanges ? 'REŽIM: --apply (mení stav a publikácie)' : 'REŽIM: dry-run (nič sa nemení)');
console.log(`zdroj: ${source} → cieľ: ${target}\n`);

const [sourceProducts, targetProducts, targetPubs] = await Promise.all([
  loadProducts(source),
  loadProducts(target),
  graphql(target, PUBLICATIONS).then((d) => d.publications.nodes),
]);

const pubByName = new Map(targetPubs.map((p) => [p.name, p]));

let changed = 0;
for (const [sku, srcP] of sourceProducts) {
  const tgtP = targetProducts.get(sku);
  if (!tgtP) continue; // chýbajúci produkt rieši iný nástroj (catalog-pull.mjs zisťuje párovanie)
  if (onlyHandles && !onlyHandles.has(tgtP.handle)) continue;

  const statusMismatch = tgtP.status !== srcP.status;
  const srcPublishedNames = new Set(
    srcP.resourcePublicationsV2.nodes.filter((n) => n.isPublished).map((n) => n.publication.name),
  );
  const tgtPublishedNames = new Set(
    tgtP.resourcePublicationsV2.nodes.filter((n) => n.isPublished).map((n) => n.publication.name),
  );
  const missingChannels = [...srcPublishedNames].filter((name) => pubByName.has(name) && !tgtPublishedNames.has(name));
  const extraChannels = [...tgtPublishedNames].filter((name) => !srcPublishedNames.has(name));

  if (!statusMismatch && missingChannels.length === 0 && extraChannels.length === 0) continue;

  changed++;
  console.log(`[${tgtP.handle}] "${tgtP.title}"`);
  if (statusMismatch) console.log(`  status:  ${tgtP.status} → ${srcP.status}  (zdroj ${srcP.handle})`);
  if (missingChannels.length) console.log(`  kanály:  chýba   ${missingChannels.join(', ')}`);
  if (extraChannels.length) console.log(`  kanály:  naviac  ${extraChannels.join(', ')}`);

  if (!applyChanges) continue;

  if (statusMismatch) {
    const r = await graphql(target, STATUS_UPDATE, { id: tgtP.id, status: srcP.status });
    const errors = r.productUpdate.userErrors;
    if (errors.length) throw new Error(`status update zlyhal pre ${tgtP.handle}: ${JSON.stringify(errors)}`);
  }
  if (missingChannels.length) {
    const input = missingChannels.map((name) => ({ publicationId: pubByName.get(name).id }));
    const r = await graphql(target, PUBLISH, { id: tgtP.id, input });
    const errors = r.publishablePublish.userErrors;
    if (errors.length) throw new Error(`publish zlyhal pre ${tgtP.handle}: ${JSON.stringify(errors)}`);
  }
  if (extraChannels.length) {
    const input = extraChannels.map((name) => ({ publicationId: pubByName.get(name).id }));
    const r = await graphql(target, UNPUBLISH, { id: tgtP.id, input });
    const errors = r.publishableUnpublish.userErrors;
    if (errors.length) throw new Error(`unpublish zlyhal pre ${tgtP.handle}: ${JSON.stringify(errors)}`);
  }
  console.log('  hotovo');
}

if (changed === 0) console.log('Žiadny rozdiel — portfólio je zosúladené.');
