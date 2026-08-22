#!/usr/bin/env node
/**
 * Mirrors stock levels from SK (the source of truth) onto the other backends,
 * matched by SKU.
 *
 *   node scripts/inventory-mirror.mjs                 # dry run, all targets
 *   node scripts/inventory-mirror.mjs pl              # dry run, PL only
 *   node scripts/inventory-mirror.mjs pl --apply      # actually write
 *
 * Dry run is the default: nothing is written unless --apply is passed.
 *
 * Caveat worth knowing: this is a one-way copy, not shared inventory. After it
 * runs the numbers match, but a sale on PL does not decrement CZ — they drift
 * apart again until the next run.
 */

import { graphql, paginate, shopKeys } from '../lib/shopify.mjs';

const SOURCE = 'sk';
const BATCH = 100;

const VARIANTS = `query V($first: Int!, $after: String) {
  productVariants(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku title
      product { handle status }
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 5) {
          nodes {
            location { id name }
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
}`;

/** The store's single active location — every backend here has exactly one. */
async function primaryLocation(store) {
  const d = await graphql(store, '{ locations(first: 10) { nodes { id name isActive } } }');
  const active = d.locations.nodes.filter((l) => l.isActive);
  if (active.length !== 1) {
    throw new Error(`[${store}] expected exactly one active location, found ${active.length}`);
  }
  return active[0];
}

async function readVariants(store) {
  const location = await primaryLocation(store);
  const variants = await paginate(store, VARIANTS, (x) => x.productVariants, { pageSize: 100 });

  const rows = [];
  const untracked = [];
  for (const v of variants) {
    const sku = v.sku?.trim();
    if (!sku) continue;
    const level = v.inventoryItem.inventoryLevels.nodes.find((l) => l.location.id === location.id);
    const available = level?.quantities?.find((q) => q.name === 'available')?.quantity ?? null;
    const row = {
      sku,
      variantId: v.id,
      inventoryItemId: v.inventoryItem.id,
      handle: v.product.handle,
      status: v.product.status,
      variantTitle: v.title,
      available,
    };
    // Quantities on an untracked item are inert — Shopify sells regardless — so
    // these are reported rather than written, and never used as a source value.
    if (v.inventoryItem?.tracked) rows.push(row);
    else untracked.push(row);
  }
  return { location, rows, untracked };
}

const SET = `mutation Set($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup { createdAt reason }
    userErrors { field message code }
  }
}`;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const targets = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const stores = (targets.length ? targets : shopKeys().filter((k) => k !== SOURCE))
  .filter((k) => k !== SOURCE);

if (!stores.length) {
  console.error('No target backends. Pass keys, e.g. `node scripts/inventory-mirror.mjs pl`.');
  process.exit(1);
}

console.log(`source: ${SOURCE.toUpperCase()}   targets: ${stores.map((s) => s.toUpperCase()).join(', ')}`);
console.log(apply ? '*** APPLY — writing to Shopify ***\n' : 'dry run — nothing will be written\n');

const source = await readVariants(SOURCE);

// A SKU can sit on several variants in SK too — typically a live product plus an
// archived discount copy that still holds stale numbers. The live listing is the
// authoritative one, so rank ACTIVE first and report anything still ambiguous.
const sourceQty = new Map();
const bySourceSku = {};
for (const r of source.rows) {
  if (r.available === null) continue;
  (bySourceSku[r.sku] ??= []).push(r);
}
for (const [sku, rows] of Object.entries(bySourceSku)) {
  const ranked = [...rows].sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE'));
  const chosen = ranked[0];
  sourceQty.set(sku, chosen.available);

  const others = ranked.slice(1).filter((r) => r.available !== chosen.available);
  if (others.length) {
    const live = ranked.filter((r) => r.status === 'ACTIVE').length;
    const note = live === 1 ? 'using the ACTIVE listing' : 'AMBIGUOUS — no single ACTIVE listing';
    console.log(`  ! SK has ${sku} on ${rows.length} listings with differing stock ` +
      `(${ranked.map((r) => `${r.available}/${r.status}`).join(', ')}) — ${note}`);
  }
}
console.log(`SK: ${source.rows.length} tracked variants, ${sourceQty.size} distinct SKUs @ ${source.location.name}\n`);

let totalChanges = 0;

for (const store of stores) {
  const target = await readVariants(store);
  const changes = [];
  const missing = [];

  for (const r of target.rows) {
    if (!sourceQty.has(r.sku)) {
      missing.push(r);
      continue;
    }
    const want = sourceQty.get(r.sku);
    if (r.available !== want) changes.push({ ...r, want });
  }

  console.log(`=== ${store.toUpperCase()} @ ${target.location.name} — ${target.rows.length} tracked, ${target.untracked.length} untracked`);
  console.log(`    ${changes.length} to change, ${target.rows.length - changes.length - missing.length} already match, ${missing.length} SKU not on SK`);

  if (target.untracked.length) {
    // Without tracking these sell without limit, so mirroring numbers onto them
    // would change nothing a customer can see.
    const alsoOnSk = target.untracked.filter((r) => sourceQty.has(r.sku));
    console.log(`    ! ${target.untracked.length} variant(s) have inventory tracking OFF — stock here is not enforced.`);
    console.log(`      ${alsoOnSk.length} of them exist on SK, so they would need tracking enabled before a mirror means anything.`);
  }

  // Several variants in this store sharing one SKU each get SK's number, which
  // inflates the store's apparent total for that product.
  const bySku = {};
  for (const c of changes) (bySku[c.sku] ??= []).push(c);
  const duplicated = Object.entries(bySku).filter(([, list]) => list.length > 1);
  if (duplicated.length) {
    console.log(`    note: ${duplicated.length} SKU(s) appear on more than one variant here and will each be set to SK's number:`);
    for (const [sku, list] of duplicated.slice(0, 5)) {
      console.log(`      ${sku} -> ${list.map((c) => `${c.handle}[${c.variantTitle}]`).join(', ')}`);
    }
  }

  for (const c of changes.slice(0, 15)) {
    console.log(`      ${c.available === null ? 'null' : String(c.available).padStart(6)} -> ${String(c.want).padStart(6)}  ${c.sku}  ${c.handle}[${c.variantTitle}]${c.status !== 'ACTIVE' ? ` (${c.status})` : ''}`);
  }
  if (changes.length > 15) console.log(`      ... and ${changes.length - 15} more`);
  if (missing.length) {
    console.log(`    SKU not on SK (left alone): ${[...new Set(missing.map((m) => m.sku))].join(', ')}`);
  }

  totalChanges += changes.length;

  if (apply && changes.length) {
    const stamp = new Date().toISOString();
    for (let i = 0; i < changes.length; i += BATCH) {
      const slice = changes.slice(i, i + BATCH);
      const res = await graphql(store, SET, {
        input: {
          reason: 'correction',
          name: 'available',
          referenceDocumentUri: `gid://perperuna-catalog/InventoryMirror/${stamp}`,
          quantities: slice.map((c) => ({
            inventoryItemId: c.inventoryItemId,
            locationId: target.location.id,
            quantity: c.want,
          })),
        },
      });
      const errs = res.inventorySetQuantities.userErrors;
      if (errs.length) {
        console.log(`    ✗ batch ${i / BATCH + 1}: ${JSON.stringify(errs).slice(0, 400)}`);
      } else {
        console.log(`    ✓ batch ${i / BATCH + 1}: ${slice.length} variants set`);
      }
    }
  }
  console.log();
}

console.log(apply
  ? `Done. ${totalChanges} variant(s) written.`
  : `Dry run complete. ${totalChanges} variant(s) would change. Re-run with --apply to write.`);
