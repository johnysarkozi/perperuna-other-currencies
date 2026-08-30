#!/usr/bin/env node
/**
 * Replikuje automatickú "Kúp X, získaj Y" (BXGY) zľavu z jedného backendu na
 * druhý, keyed by SKU (rovnaká logika párovania ako `catalog-pull.mjs`).
 *
 * Použitie: keď na SK vznikne akcia typu „1+1" naviazaná na konkrétne
 * produkty, tento skript nájde tú istú zľavu podľa názvu, prelúpi zoznam
 * produktov cez SKU na ekvivalentné produkty cieľového backendu a založí
 * (alebo nahlási) rovnakú zľavu tam. Percentá, množstvá, `combinesWith`
 * a časové okno preberá 1:1 zo zdroja — nič neprepočítava.
 *
 *   node scripts/sync-bxgy-discount.mjs pl "1+1"                 # dry-run, zdroj sk
 *   node scripts/sync-bxgy-discount.mjs pl "1+1" --source sk --apply
 *
 * Ak už na cieli existuje aktívna automatická zľava s rovnakým názvom,
 * skript nič nezakladá a len to nahlási — nech si ho vieš spustiť opakovane
 * bez rizika duplicity.
 */

import { paginate, graphql } from '../lib/shopify.mjs';

const STATUS_RANK = { ACTIVE: 0, DRAFT: 1, UNLISTED: 2, ARCHIVED: 3 };

const PRODUCTS = `query P($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id handle title status variants(first: 25) { nodes { sku } } }
  }
}`;

const FIND_DISCOUNT = `query D($first: Int!, $after: String) {
  discountNodes(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      discount {
        __typename
        ... on DiscountAutomaticBxgy {
          title status startsAt endsAt
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
          customerBuys {
            value { ... on DiscountQuantity { quantity } }
            items { ... on DiscountProducts { products(first: 50) { nodes { id title handle } } } }
          }
          customerGets {
            value { ... on DiscountOnQuantity { quantity { quantity } effect { ... on DiscountPercentage { percentage } } } }
            items { ... on DiscountProducts { products(first: 50) { nodes { id title handle } } } }
          }
        }
      }
    }
  }
}`;

const CREATE = `mutation($input: DiscountAutomaticBxgyInput!) {
  discountAutomaticBxgyCreate(automaticBxgyDiscount: $input) {
    automaticDiscountNode { id }
    userErrors { field message }
  }
}`;

function skuKey(product) {
  const skus = product.variants.nodes.map((v) => v.sku).filter(Boolean);
  return skus.length ? skus.join(',') : null;
}

async function loadProductsBySku(key) {
  const nodes = await paginate(key, PRODUCTS, (d) => d.products);
  const bySku = new Map();
  for (const p of nodes) {
    const sku = skuKey(p);
    if (!sku) continue;
    const existing = bySku.get(sku);
    if (!existing || STATUS_RANK[p.status] < STATUS_RANK[existing.status]) bySku.set(sku, p);
  }
  return { bySku, byId: new Map(nodes.map((p) => [p.id, p])) };
}

async function findAutomaticBxgyByTitle(key, title) {
  const nodes = await paginate(key, FIND_DISCOUNT, (d) => d.discountNodes);
  return nodes.find((n) => n.discount.__typename === 'DiscountAutomaticBxgy' && n.discount.title === title);
}

const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const sourceIdx = args.indexOf('--source');
const source = sourceIdx >= 0 ? args[sourceIdx + 1] : 'sk';
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--source');
const [target, title] = positional;

if (!target || !title) {
  console.error('použitie: node scripts/sync-bxgy-discount.mjs <target> "<názov zľavy>" [--source sk] [--apply]');
  process.exit(1);
}

console.log(applyChanges ? 'REŽIM: --apply (zakladá zľavu)' : 'REŽIM: dry-run (nič sa nezakladá)');
console.log(`zdroj: ${source} → cieľ: ${target}  |  zľava: "${title}"\n`);

const srcNode = await findAutomaticBxgyByTitle(source, title);
if (!srcNode) {
  console.error(`na "${source}" som automatickú BXGY zľavu s názvom "${title}" nenašiel.`);
  process.exit(1);
}
const src = srcNode.discount;
console.log(`zdroj nájdený: status ${src.status}, štart ${src.startsAt}, koniec ${src.endsAt ?? '—'}`);
console.log(
  `  Kúp ${src.customerBuys.value.quantity} → získaj ${src.customerGets.value.quantity.quantity} so zľavou ${src.customerGets.value.effect.percentage * 100}%`,
);

const existing = await findAutomaticBxgyByTitle(target, title);
if (existing) {
  console.log(`\nna "${target}" už zľava "${title}" existuje (status ${existing.discount.status}) — nič nezakladám.`);
  process.exit(0);
}

const { bySku: srcBySku } = await loadProductsBySku(source);
const { bySku: tgtBySku } = await loadProductsBySku(target);

function mapProducts(items, label) {
  const out = [];
  const missing = [];
  for (const p of items.products.nodes) {
    const srcFull = [...srcBySku.entries()].find(([, v]) => v.handle === p.handle);
    const sku = srcFull?.[0];
    const tgt = sku ? tgtBySku.get(sku) : null;
    if (!tgt) {
      missing.push(p.handle);
      continue;
    }
    out.push(tgt);
  }
  console.log(`  ${label}: ${out.length}/${items.products.nodes.length} produktov sa spárovalo`);
  if (missing.length) console.log(`    chýba ekvivalent pre: ${missing.join(', ')}`);
  return { out, missing };
}

console.log('\npárovanie produktov cez SKU:');
const buys = mapProducts(src.customerBuys.items, 'customerBuys');
const gets = mapProducts(src.customerGets.items, 'customerGets');

if (buys.missing.length || gets.missing.length) {
  console.error('\nniektoré produkty sa nepodarilo spárovať — over ich existenciu na cieli pred založením zľavy.');
  process.exit(1);
}

console.log('\ncieľové produkty:');
for (const p of new Set([...buys.out, ...gets.out])) console.log(`  ${p.status.padEnd(8)} ${p.handle}  [${p.title}]`);

if (!applyChanges) {
  console.log('\ndry-run: zľava by sa založila s vyššie uvedenými produktmi.');
  process.exit(0);
}

const input = {
  title: src.title,
  startsAt: new Date().toISOString(),
  endsAt: src.endsAt,
  combinesWith: src.combinesWith,
  customerBuys: {
    value: { quantity: src.customerBuys.value.quantity },
    items: { products: { productsToAdd: buys.out.map((p) => p.id) } },
  },
  customerGets: {
    value: {
      discountOnQuantity: {
        quantity: src.customerGets.value.quantity.quantity,
        effect: { percentage: src.customerGets.value.effect.percentage },
      },
    },
    items: { products: { productsToAdd: gets.out.map((p) => p.id) } },
  },
};

const result = await graphql(target, CREATE, { input });
const errors = result.discountAutomaticBxgyCreate.userErrors;
if (errors.length) throw new Error(`založenie zľavy zlyhalo: ${JSON.stringify(errors)}`);
console.log(`\nzaložené: ${result.discountAutomaticBxgyCreate.automaticDiscountNode.id}`);
