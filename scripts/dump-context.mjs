#!/usr/bin/env node
/**
 * Snapshots the shape of every backend: store settings, markets, currencies,
 * locales, catalog and order volumes, sales channels, themes, locations and
 * metafield/metaobject definitions.
 *
 * Writes docs/shop-context.json and prints a human-readable summary. Reads
 * only — never mutates a store.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { graphql, forEachShop, shopKeys } from '../lib/shopify.mjs';

const SHOP_QUERY = `{
  shop {
    name
    myshopifyDomain
    email
    contactEmail
    currencyCode
    ianaTimezone
    weightUnit
    plan { displayName partnerDevelopment shopifyPlus }
    primaryDomain { host url }
    billingAddress { country countryCodeV2 city }
    currencyFormats { moneyFormat moneyWithCurrencyFormat }
    resourceLimits { maxProductVariants }
  }
  shopLocales { locale name primary published }
  markets(first: 25) {
    nodes {
      name
      handle
      status
      currencySettings { baseCurrency { currencyCode } localCurrencies }
      webPresences(first: 5) {
        nodes { domain { host } subfolderSuffix defaultLocale { locale } alternateLocales { locale } }
      }
      catalogsCount { count }
    }
  }
  productsCount { count }
  ordersCount: orders(first: 1) { nodes { id } }
  collections(first: 250) { nodes { id title handle productsCount { count } } }
  publications(first: 25) { nodes { id name supportsFuturePublishing } }
  locations(first: 25) { nodes { id name isActive fulfillsOnlineOrders address { country countryCode city } } }
  themes(first: 25) { nodes { id name role prefix processing themeStoreId } }
  metafieldDefinitions(first: 100, ownerType: PRODUCT) { nodes { key namespace name type { name } } }
  metaobjectDefinitions(first: 50) { nodes { type name fieldDefinitions { key name } } }
}`;

const COUNTS_QUERY = `query Counts($q: String) {
  ordersCount(query: $q, limit: 100000) { count precision }
}`;

const ORDER_STATS_QUERY = `query Recent($q: String!) {
  orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes {
      name
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
    }
  }
}`;

const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

async function collect(key) {
  const base = await graphql(key, SHOP_QUERY);

  const counts = await graphql(key, COUNTS_QUERY, { q: `created_at:>=${since}` }).catch((e) => ({
    _error: e.message,
  }));
  const recent = await graphql(key, ORDER_STATS_QUERY, { q: `created_at:>=${since}` }).catch((e) => ({
    _error: e.message,
  }));

  return { ...base, ordersLast90d: counts.ordersCount ?? counts._error, recentOrders: recent.orders?.nodes ?? recent._error };
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const keys = targets.length ? targets : shopKeys();

const results = await forEachShop(collect, keys);

await mkdir('docs', { recursive: true });
await writeFile(
  'docs/shop-context.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), ordersWindowSince: since, results }, null, 2),
);

for (const r of results) {
  if (!r.ok) {
    console.log(`\n✗ ${r.key.toUpperCase()} — ${r.error}`);
    continue;
  }
  const d = r.value;
  const s = d.shop;
  console.log(`\n=== ${r.key.toUpperCase()} — ${s.name} ===`);
  console.log(`  domain      ${s.primaryDomain.host}  (${s.myshopifyDomain})`);
  console.log(`  currency    ${s.currencyCode}   format: ${s.currencyFormats.moneyFormat}`);
  console.log(`  plan        ${s.plan.displayName}   tz: ${s.ianaTimezone}   weight: ${s.weightUnit}`);
  console.log(`  country     ${s.billingAddress?.countryCodeV2 ?? '?'}   contact: ${s.contactEmail ?? s.email}`);
  console.log(`  locales     ${d.shopLocales.map((l) => `${l.locale}${l.primary ? '*' : ''}${l.published ? '' : '(unpub)'}`).join(', ')}`);
  console.log(`  products    ${d.productsCount.count}   collections: ${d.collections.nodes.length}`);
  console.log(`  orders/90d  ${typeof d.ordersLast90d === 'object' ? `${d.ordersLast90d.count} (${d.ordersLast90d.precision})` : d.ordersLast90d}`);
  console.log(`  locations   ${d.locations.nodes.map((l) => `${l.name}/${l.address?.countryCode ?? '?'}`).join(', ')}`);
  console.log(`  channels    ${d.publications.nodes.map((p) => p.name).join(', ')}`);
  console.log(`  theme(live) ${d.themes.nodes.find((t) => t.role === 'MAIN')?.name ?? '?'}`);

  for (const m of d.markets.nodes) {
    const wp = m.webPresences.nodes[0];
    // currencySettings is null on markets that inherit the shop currency.
    const cur = m.currencySettings;
    console.log(
      `  market      ${m.name} [${m.status}] ${cur?.baseCurrency?.currencyCode ?? s.currencyCode}` +
        `${cur?.localCurrencies ? '+local' : ''}` +
        `${wp ? ` @ ${wp.domain?.host ?? ''}${wp.subfolderSuffix ? '/' + wp.subfolderSuffix : ''} (${[wp.defaultLocale?.locale, ...wp.alternateLocales.map((l) => l.locale)].filter(Boolean).join(',')})` : ''}`,
    );
  }

  const mf = d.metafieldDefinitions.nodes;
  if (mf.length) console.log(`  product mf  ${mf.map((m) => `${m.namespace}.${m.key}`).join(', ')}`);
  const mo = d.metaobjectDefinitions.nodes;
  if (mo.length) console.log(`  metaobjects ${mo.map((m) => m.type).join(', ')}`);
}

console.log('\nFull snapshot written to docs/shop-context.json');
process.exit(results.every((r) => r.ok) ? 0 : 1);
