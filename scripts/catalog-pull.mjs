#!/usr/bin/env node
/**
 * Reads product/variant/price/inventory data from every backend and emits the
 * SQL that mirrors it into the shared catalog (catalog_products,
 * catalog_listings), keyed by SKU.
 *
 * Read-only against Shopify, and writes nothing itself — it prints SQL to
 * stdout, which is then applied to Supabase through the MCP connector. That
 * keeps the Supabase credentials in the connector instead of adding another
 * secret to the environment.
 *
 *   node scripts/catalog-pull.mjs > /tmp/catalog.sql
 *   node scripts/catalog-pull.mjs cz pl > /tmp/catalog.sql
 *
 * The generated SQL is idempotent (upsert on store + variant id), so applying
 * it repeatedly is safe.
 */

import { graphql, paginate, shopKeys } from '../lib/shopify.mjs';

const PRODUCTS = `query P($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status
      featuredMedia { preview { image { url } } }
      variants(first: 25) {
        nodes {
          id title sku price compareAtPrice inventoryPolicy
          inventoryItem {
            id
            inventoryLevels(first: 1) {
              nodes { quantities(names: ["available"]) { name quantity } }
            }
          }
        }
      }
    }
  }
}`;

/** Quote a value as a SQL string literal, or NULL. */
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
/** Emit a numeric literal, or NULL. */
const num = (v) => (v === null || v === undefined || v === '' ? 'NULL' : Number(v));

async function readStore(key) {
  const { shop } = await graphql(key, '{ shop { currencyCode } }');
  const products = await paginate(key, PRODUCTS, (x) => x.products, { pageSize: 50 });

  const rows = [];
  for (const p of products) {
    for (const v of p.variants.nodes) {
      const sku = v.sku?.trim();
      if (!sku) continue;
      const available = v.inventoryItem?.inventoryLevels?.nodes?.[0]
        ?.quantities?.find((x) => x.name === 'available');
      rows.push({
        sku,
        store: key,
        shopify_product_id: p.id,
        shopify_variant_id: v.id,
        handle: p.handle,
        title: p.title,
        variant_title: v.title,
        status: p.status,
        currency: shop.currencyCode,
        price: v.price,
        compare_at_price: v.compareAtPrice,
        inventory_item_id: v.inventoryItem?.id ?? null,
        inventory_quantity: available ? available.quantity : null,
        inventory_policy: v.inventoryPolicy,
        image_url: p.featuredMedia?.preview?.image?.url ?? null,
      });
    }
  }
  return { rows, productCount: products.length };
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const keys = targets.length ? targets : shopKeys().filter((k) => k !== 'sk');

const rows = [];
for (const key of keys) {
  const { rows: storeRows, productCount } = await readStore(key);
  rows.push(...storeRows);
  console.error(`${key}: ${productCount} products, ${storeRows.length} SKU'd variants`);
}

const skus = [...new Set(rows.map((r) => r.sku))].sort();
console.error(`total: ${rows.length} listings, ${skus.length} distinct SKUs`);

const out = [];
out.push('begin;');
out.push(
  'insert into public.catalog_products (sku) values\n  ' +
    skus.map((s) => `(${q(s)})`).join(',\n  ') +
    '\non conflict (sku) do nothing;',
);
out.push(
  'insert into public.catalog_listings (sku, store, shopify_product_id, shopify_variant_id,' +
    ' handle, title, variant_title, status, currency, price, compare_at_price,' +
    ' inventory_item_id, inventory_quantity, inventory_policy, image_url, synced_at) values\n  ' +
    rows
      .map(
        (r) =>
          `(${q(r.sku)}, ${q(r.store)}, ${q(r.shopify_product_id)}, ${q(r.shopify_variant_id)},` +
          ` ${q(r.handle)}, ${q(r.title)}, ${q(r.variant_title)}, ${q(r.status)}, ${q(r.currency)},` +
          ` ${num(r.price)}, ${num(r.compare_at_price)}, ${q(r.inventory_item_id)},` +
          ` ${num(r.inventory_quantity)}, ${q(r.inventory_policy)}, ${q(r.image_url)}, now())`,
      )
      .join(',\n  ') +
    '\non conflict (store, shopify_variant_id) do update set' +
    '\n  sku = excluded.sku,' +
    '\n  handle = excluded.handle,' +
    '\n  title = excluded.title,' +
    '\n  variant_title = excluded.variant_title,' +
    '\n  status = excluded.status,' +
    '\n  currency = excluded.currency,' +
    '\n  price = excluded.price,' +
    '\n  compare_at_price = excluded.compare_at_price,' +
    '\n  inventory_item_id = excluded.inventory_item_id,' +
    '\n  inventory_quantity = excluded.inventory_quantity,' +
    '\n  inventory_policy = excluded.inventory_policy,' +
    '\n  image_url = excluded.image_url,' +
    '\n  synced_at = now();',
);
out.push('commit;');

console.log(out.join('\n\n'));
