#!/usr/bin/env node
/**
 * Pulls product/variant/price/inventory data from every backend into the
 * shared Supabase catalog (catalog_products, catalog_listings), keyed by SKU.
 *
 * Read-only against Shopify. Writes only to Supabase. Safe to run repeatedly
 * (upsert on shopify_variant_id) — this is the "single place to look" for
 * price/stock across all backends; editing still happens per-backend until
 * the push side exists.
 */

import { graphql, paginate, shopKeys } from '../lib/shopify.mjs';
import { upsert, insert } from '../lib/supabase.mjs';

const PRODUCTS = `query P($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status
      featuredMedia { preview { image { url } } }
      variants(first: 25) {
        nodes {
          id title sku price compareAtPrice inventoryPolicy
          inventoryItem { id inventoryLevels(first: 1) { nodes { quantities(names: ["available"]) { name quantity } } } }
        }
      }
    }
  }
}`;

async function pullStore(key) {
  const shopData = await graphql(key, '{ shop { currencyCode } }');
  const currency = shopData.shop.currencyCode;
  const products = await paginate(key, PRODUCTS, (x) => x.products, { pageSize: 50 });

  const skus = new Set();
  const listings = [];

  for (const p of products) {
    for (const v of p.variants.nodes) {
      const sku = v.sku?.trim();
      if (!sku) continue;
      skus.add(sku);
      const available = v.inventoryItem?.inventoryLevels?.nodes?.[0]?.quantities?.find((q) => q.name === 'available');
      listings.push({
        sku,
        store: key,
        shopify_product_id: p.id,
        shopify_variant_id: v.id,
        handle: p.handle,
        title: p.title,
        variant_title: v.title,
        status: p.status,
        currency,
        price: v.price ? Number(v.price) : null,
        compare_at_price: v.compareAtPrice ? Number(v.compareAtPrice) : null,
        inventory_item_id: v.inventoryItem?.id ?? null,
        inventory_quantity: available ? available.quantity : null,
        inventory_policy: v.inventoryPolicy,
        image_url: p.featuredMedia?.preview?.image?.url ?? null,
        synced_at: new Date().toISOString(),
      });
    }
  }

  return { skus, listings, productCount: products.length };
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const keys = targets.length ? targets : shopKeys().filter((k) => k !== 'sk');

const allSkus = new Set();
const allListings = [];

for (const key of keys) {
  console.log(`pulling ${key}...`);
  const { skus, listings, productCount } = await pullStore(key);
  for (const s of skus) allSkus.add(s);
  allListings.push(...listings);
  console.log(`  ${productCount} products, ${listings.length} SKU'd variants`);
}

console.log(`\nupserting ${allSkus.size} SKUs into catalog_products...`);
await upsert('catalog_products', [...allSkus].map((sku) => ({ sku })), { onConflict: 'sku' });

console.log(`upserting ${allListings.length} listings into catalog_listings...`);
// Chunk to keep request bodies reasonable.
for (let i = 0; i < allListings.length; i += 200) {
  await upsert('catalog_listings', allListings.slice(i, i + 200), { onConflict: 'store,shopify_variant_id' });
}

console.log('done.');
