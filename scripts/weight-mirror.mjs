#!/usr/bin/env node
/**
 * Mirrors variant weights from SK (the source of truth) onto the other
 * backends, matched by SKU.
 *
 *   node scripts/weight-mirror.mjs                 # dry run, all targets
 *   node scripts/weight-mirror.mjs ro pl           # dry run, RO and PL only
 *   node scripts/weight-mirror.mjs ro pl --apply   # actually write
 *
 * Dry run is the default: nothing is written unless --apply is passed.
 *
 * Why it matters: a variant at 0 kg breaks weight-based shipping rates — the
 * carrier bands never match, so the customer sees the wrong price or no
 * shipping option at all. Unlike stock, weight is a static property of the
 * product, so once mirrored it stays correct.
 */

import { graphql, paginate, shopKeys } from '../lib/shopify.mjs';

const SOURCE = 'sk';
const BATCH = 100;

const VARIANTS = `query V($first: Int!, $after: String) {
  productVariants(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku title
      product { id handle status }
      inventoryItem {
        id
        requiresShipping
        measurement { weight { value unit } }
      }
    }
  }
}`;

/** Weights are compared in grams so a kg/g unit difference isn't read as a change. */
const TO_GRAMS = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 };

const grams = (w) => (w ? w.value * (TO_GRAMS[w.unit] ?? NaN) : null);
const show = (w) => (w ? `${w.value} ${w.unit === 'KILOGRAMS' ? 'kg' : w.unit.toLowerCase()}` : 'none');

async function readVariants(store) {
  const variants = await paginate(store, VARIANTS, (x) => x.productVariants, { pageSize: 100 });

  const rows = [];
  for (const v of variants) {
    const sku = v.sku?.trim();
    if (!sku) continue;
    rows.push({
      sku,
      variantId: v.id,
      productId: v.product.id,
      handle: v.product.handle,
      status: v.product.status,
      variantTitle: v.title,
      requiresShipping: v.inventoryItem?.requiresShipping ?? true,
      weight: v.inventoryItem?.measurement?.weight ?? null,
    });
  }
  return rows;
}

const UPDATE = `mutation W($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
// Escape hatch for a SKU that means different things in different stores — e.g.
// PP-NUBE-NEDO-020 is a single cube on SK but a 10-pack on CZ, so SK's weight
// would be wrong there. Copying it blind would break CZ's shipping rates.
const skip = new Set(
  args.filter((a) => a.startsWith('--skip='))
    .flatMap((a) => a.slice('--skip='.length).split(',').map((s) => s.trim()).filter(Boolean)),
);
const targets = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const stores = (targets.length ? targets : shopKeys().filter((k) => k !== SOURCE))
  .filter((k) => k !== SOURCE);

if (!stores.length) {
  console.error('No target backends. Pass keys, e.g. `node scripts/weight-mirror.mjs ro pl`.');
  process.exit(1);
}

console.log(`source: ${SOURCE.toUpperCase()}   targets: ${stores.map((s) => s.toUpperCase()).join(', ')}`);
console.log(apply ? '*** APPLY — writing to Shopify ***\n' : 'dry run — nothing will be written\n');

const source = await readVariants(SOURCE);

// A SKU can sit on several SK variants — typically a live product plus an
// archived copy. Prefer the ACTIVE listing, and prefer one that actually has a
// weight, since a 0 kg archived row would otherwise poison the target.
const sourceWeight = new Map();
const bySourceSku = {};
for (const r of source) (bySourceSku[r.sku] ??= []).push(r);

for (const [sku, rows] of Object.entries(bySourceSku)) {
  const ranked = [...rows].sort((a, b) =>
    Number((grams(b.weight) ?? 0) > 0) - Number((grams(a.weight) ?? 0) > 0) ||
    Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE'));
  const chosen = ranked[0];
  if ((grams(chosen.weight) ?? 0) > 0) sourceWeight.set(sku, chosen.weight);
}

const skZero = source.filter((r) => r.requiresShipping && !((grams(r.weight) ?? 0) > 0));
console.log(`SK: ${source.length} variants, ${sourceWeight.size} SKUs with a usable weight`);
if (skZero.length) {
  console.log(`    ! ${skZero.length} shippable SK variant(s) have no weight — those SKUs cannot be mirrored:`);
  for (const r of skZero.slice(0, 10)) {
    console.log(`      ${r.sku}  ${r.handle}[${r.variantTitle}]${r.status !== 'ACTIVE' ? ` (${r.status})` : ''}`);
  }
  if (skZero.length > 10) console.log(`      ... and ${skZero.length - 10} more`);
}
console.log();

let totalChanges = 0;
let totalWritten = 0;

for (const store of stores) {
  const target = await readVariants(store);

  const changes = [];
  const missing = [];
  let matched = 0;

  for (const r of target) {
    // Digital items and service SKUs (FEE-*) never ship, so a weight on them
    // would be meaningless.
    if (!r.requiresShipping) continue;
    if (skip.has(r.sku)) continue;
    if (!sourceWeight.has(r.sku)) {
      if (!((grams(r.weight) ?? 0) > 0)) missing.push(r);
      continue;
    }
    const want = sourceWeight.get(r.sku);
    if (grams(r.weight) === grams(want)) matched++;
    else changes.push({ ...r, want });
  }

  console.log(`=== ${store.toUpperCase()} — ${target.length} variants, ${changes.length} to change, ${matched} already match`);
  for (const c of changes.slice(0, 20)) {
    console.log(`      ${show(c.weight).padStart(10)} -> ${show(c.want).padEnd(10)}  ${c.sku}  ${c.handle}[${c.variantTitle}]${c.status !== 'ACTIVE' ? ` (${c.status})` : ''}`);
  }
  if (changes.length > 20) console.log(`      ... and ${changes.length - 20} more`);
  if (missing.length) {
    console.log(`    ! ${missing.length} shippable variant(s) have no weight and no SK weight to copy — fix by hand:`);
    console.log(`      ${[...new Set(missing.map((m) => m.sku))].join(', ')}`);
  }

  totalChanges += changes.length;

  if (apply && changes.length) {
    // productVariantsBulkUpdate is scoped to one product per call.
    const byProduct = {};
    for (const c of changes) (byProduct[c.productId] ??= []).push(c);

    let written = 0;
    for (const [productId, rows] of Object.entries(byProduct)) {
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const res = await graphql(store, UPDATE, {
          productId,
          variants: slice.map((c) => ({
            id: c.variantId,
            inventoryItem: { measurement: { weight: { value: c.want.value, unit: c.want.unit } } },
          })),
        });
        const errs = res.productVariantsBulkUpdate.userErrors;
        if (errs.length) console.log(`    ✗ ${slice[0].handle}: ${JSON.stringify(errs).slice(0, 300)}`);
        else written += slice.length;
      }
    }
    totalWritten += written;
    console.log(`    ${written}/${changes.length} variant(s) written`);
    if (written < changes.length) console.log(`    ! shortfall on ${store.toUpperCase()}`);
  }
  console.log();
}

console.log(apply
  ? `Done. ${totalWritten}/${totalChanges} variant(s) written.`
  : `Dry run complete. ${totalChanges} variant(s) would change. Re-run with --apply to write.`);
if (apply && totalWritten < totalChanges) process.exit(1);
