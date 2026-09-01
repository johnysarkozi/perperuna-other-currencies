#!/usr/bin/env node
/**
 * Launch-readiness audit for a backend, from the customer's point of view.
 *
 * Checks storefront settings, legal policies, shipping and payments, catalog
 * completeness, navigation and content — and runs every customer-visible string
 * through a language check to catch text left untranslated from another store.
 * Also does one live, unauthenticated fetch of the storefront home page to
 * catch a password-protected store — the one blocker that makes everything
 * else on this list moot, and the one Admin API data alone can't see.
 *
 * Read-only. Writes docs/launch-audit.json and prints findings grouped by
 * severity.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { graphql, paginate, shopKeys } from '../lib/shopify.mjs';
import { mismatch } from '../lib/lang.mjs';

const SETTINGS = `{
  shop {
    name
    contactEmail
    email
    url
    currencyCode
    taxesIncluded
    taxShipping
    setupRequired
    shipsToCountries
    description
    customerAccountsV2 { customerAccountsVersion loginRequiredAtCheckout }
    primaryDomain { host sslEnabled }
    shopPolicies { type title body url }
    paymentSettings { supportedDigitalWallets }
    billingAddress { country countryCodeV2 }
  }
  shopLocales { locale name primary published }
  markets(first: 25) {
    nodes {
      name handle status
      webPresences(first: 5) { nodes { domain { host sslEnabled } defaultLocale { locale } alternateLocales { locale } } }
      conditions { regionsCondition { regions(first: 20) { nodes { ... on MarketRegionCountry { code name } } } } }
    }
  }
  domains: shop { id }
}`;

const DELIVERY = `{
  deliveryProfiles(first: 10) {
    nodes {
      name
      default
      profileLocationGroups {
        locationGroupZones(first: 25) {
          nodes {
            zone { name countries { code { countryCode } name } }
            methodDefinitions(first: 25) {
              nodes { name active description rateProvider { ... on DeliveryRateDefinition { price { amount currencyCode } } } }
            }
          }
        }
      }
    }
  }
}`;

const PRODUCTS = `query P($first: Int!, $after: String, $onlineStore: ID!) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle status descriptionHtml totalInventory tracksInventory templateSuffix
      seo { title description }
      featuredMedia { id }
      mediaCount { count }
      publishedOnPublication(publicationId: $onlineStore)
      variants(first: 20) {
        nodes {
          id title price compareAtPrice sku barcode inventoryQuantity inventoryPolicy
          inventoryItem { requiresShipping measurement { weight { value unit } } }
        }
      }
    }
  }
}`;

const COLLECTIONS = `query C($first: Int!, $after: String) {
  collections(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle descriptionHtml productsCount { count } seo { title description } image { id } }
  }
}`;

const CONTENT = `{
  pages(first: 50) { nodes { id title handle body isPublished } }
  menus(first: 20) { nodes { id title handle items { title type url items { title url } } } }
  metaobjectDefinitions(first: 50) { nodes { type name metaobjectsCount } }
}`;

// Merchant-authored theme content. Vendor locale files are excluded: their
// strings are theme-editor labels for staff, not storefront copy.
const THEME_FILES = `{
  themes(first: 1, roles: [MAIN]) {
    nodes {
      name
      files(first: 250, filenames: ["templates/*.json", "sections/*.json", "config/settings_data.json"]) {
        nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
      }
    }
  }
}`;

const finding = (sev, area, msg, detail) => ({ sev, area, msg, ...(detail ? { detail } : {}) });

/**
 * Pull prose out of a theme JSON file. Shopify allows comments in these files,
 * so they can't be JSON.parse'd — string literals are read directly instead.
 */
function themeStrings(content) {
  const out = [];
  for (const m of content.matchAll(/"((?:[^"\\]|\\.){25,800})"/g)) {
    const s = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\//g, '/');
    if (/^(shopify|https?):/.test(s) || !/\s/.test(s)) continue;
    out.push(s);
  }
  return out;
}

async function audit(key) {
  const out = [];
  const push = (...f) => out.push(...f);

  const s = await graphql(key, SETTINGS);
  const shop = s.shop;
  const locale = s.shopLocales.find((l) => l.primary)?.locale ?? 'xx';
  const country = s.markets.nodes[0]?.conditions?.regionsCondition?.regions?.nodes?.[0]?.code;

  // --- storefront reachability -------------------------------------------
  const wp = s.markets.nodes.find((m) => m.status === 'ACTIVE')?.webPresences.nodes[0];
  if (shop.primaryDomain.host.endsWith('.myshopify.com')) {
    push(finding('blocker', 'domain',
      `Primárna doména je stále ${shop.primaryDomain.host} — vlastná doména nie je dokončená`,
      { marketDomain: wp?.domain?.host }));
  }
  if (wp?.domain && !wp.domain.sslEnabled) {
    push(finding('blocker', 'domain', `SSL nie je aktívne na ${wp.domain.host}`));
  }
  try {
    const res = await fetch(`https://${shop.primaryDomain.host}/`, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && /\/password(\?|$)/.test(res.headers.get('location') ?? '')) {
      push(finding('blocker', 'storefront',
        'Obchod je chránený heslom (Online Store → Preferences) — nijaký zákazník sa nedostane ďalej ako na stránku s heslom'));
    }
  } catch (e) {
    push(finding('warn', 'storefront', `Nepodarilo sa overiť dostupnosť obchodu naživo: ${e.message}`));
  }

  if (shop.setupRequired) {
    push(finding('blocker', 'setup', 'Obchod má nedokončené kroky nastavenia (setupRequired = true)'));
  }

  // --- locales -----------------------------------------------------------
  const unpublished = s.shopLocales.filter((l) => !l.published);
  if (unpublished.length) {
    push(finding('warn', 'locale', `Nepublikované jazyky: ${unpublished.map((l) => l.locale).join(', ')}`));
  }

  // --- legal policies ----------------------------------------------------
  const required = {
    REFUND_POLICY: 'Reklamačný / vrátenie tovaru',
    PRIVACY_POLICY: 'Ochrana osobných údajov',
    TERMS_OF_SERVICE: 'Obchodné podmienky',
    SHIPPING_POLICY: 'Doprava',
  };
  const byType = Object.fromEntries(shop.shopPolicies.map((p) => [p.type, p]));
  for (const [type, label] of Object.entries(required)) {
    const p = byType[type];
    const len = (p?.body ?? '').replace(/<[^>]*>/g, '').trim().length;
    if (!p || len < 200) {
      push(finding('blocker', 'policy', `${label}: ${!p ? 'chýba' : `len ${len} znakov — pravdepodobne prázdne`}`));
      continue;
    }
    const m = mismatch(p.body, locale);
    if (m) push(finding('blocker', 'policy', `${label}: text vyzerá ako ${m.got}, očakávané ${m.expected}`));
  }

  // --- shipping ----------------------------------------------------------
  const d = await graphql(key, DELIVERY);
  const zones = d.deliveryProfiles.nodes.flatMap((p) =>
    p.profileLocationGroups.flatMap((g) => g.locationGroupZones.nodes));
  const countries = new Set(zones.flatMap((z) => z.zone.countries.map((c) => c.code.countryCode)));
  const rates = zones.flatMap((z) => z.methodDefinitions.nodes);
  const activeRates = rates.filter((r) => r.active);

  if (country && !countries.has(country) && !countries.has('*')) {
    push(finding('blocker', 'shipping', `Cieľová krajina ${country} nie je v žiadnej dopravnej zóne — zákazník neprejde checkoutom`,
      { zonyPokryvaju: [...countries] }));
  } else if (country) {
    // A home market covered only by a catch-all zone means the domestic zone was
    // never localised — the customer is quoted an international rate.
    const home = zones.find((z) => z.zone.countries.some((c) => c.code.countryCode === country));
    if (home && home.zone.countries.length > 5) {
      push(finding('blocker', 'shipping',
        `${country} je pokrytá len zbernou zónou „${home.zone.name}" (${home.zone.countries.length} krajín) — nemá vlastnú domácu zónu`,
        { sadzby: home.methodDefinitions.nodes.map((m) => `${m.name} ${m.rateProvider?.price?.amount ?? '?'} ${m.rateProvider?.price?.currencyCode ?? ''}`) }));
    }
  }
  if (!activeRates.length) {
    push(finding('blocker', 'shipping', 'Žiadna aktívna dopravná sadzba — zákazník neprejde checkoutom'));
  }

  // Rates priced in another currency mean the zone was copied from a different
  // backend and never converted.
  const wrongCurrency = activeRates.filter(
    (r) => r.rateProvider?.price && r.rateProvider.price.currencyCode !== shop.currencyCode);
  if (wrongCurrency.length) {
    push(finding('blocker', 'shipping',
      `${wrongCurrency.length} dopravných sadzieb je v inej mene než obchod (${shop.currencyCode})`,
      { sadzby: wrongCurrency.map((r) => `${r.name}: ${r.rateProvider.price.amount} ${r.rateProvider.price.currencyCode}`) }));
  }
  for (const r of activeRates) {
    const m = mismatch(`${r.name} ${r.description ?? ''}`, locale);
    if (m) push(finding('warn', 'shipping', `Sadzba „${r.name}" vyzerá ako ${m.got}, očakávané ${m.expected}`));
  }

  // --- payments ----------------------------------------------------------
  // Digital wallets appear once a payment provider is live, so an empty list is
  // a strong hint that no provider is activated at all.
  if (!shop.paymentSettings.supportedDigitalWallets?.length) {
    push(finding('blocker', 'payments',
      'Žiadne digitálne peňaženky — pravdepodobne nie je aktivovaná platobná brána; over v Settings → Payments'));
  }

  // --- catalog -----------------------------------------------------------
  const pubs = await graphql(key, '{ publications(first: 25) { nodes { id name } } }');
  const onlineStore = pubs.publications.nodes.find((p) => p.name === 'Online Store')?.id;
  if (!onlineStore) push(finding('blocker', 'channel', 'Online Store kanál nie je nainštalovaný'));

  const products = await paginate(key, PRODUCTS, (x) => x.products, {
    pageSize: 50,
    variables: { onlineStore },
  });
  const collections = await paginate(key, COLLECTIONS, (x) => x.collections, { pageSize: 100 });

  const active = products.filter((p) => p.status === 'ACTIVE');
  const drafts = products.filter((p) => p.status === 'DRAFT');
  const unpub = active.filter((p) => !p.publishedOnPublication);
  const noMedia = active.filter((p) => !p.featuredMedia);
  const noDesc = active.filter((p) => (p.descriptionHtml ?? '').replace(/<[^>]*>/g, '').trim().length < 50);
  const noSeo = active.filter((p) => !p.seo?.description);
  const zeroPrice = active.flatMap((p) =>
    p.variants.nodes.filter((v) => Number(v.price) === 0).map((v) => `${p.handle} [${v.title}]`));
  const noStock = active.filter((p) =>
    p.tracksInventory && (p.totalInventory ?? 0) <= 0 &&
    p.variants.nodes.every((v) => v.inventoryPolicy === 'DENY'));
  // Only physical goods need a weight; digital items legitimately have none.
  const noWeight = active.filter((p) =>
    p.variants.nodes.some((v) =>
      v.inventoryItem?.requiresShipping && !(v.inventoryItem?.measurement?.weight?.value > 0)));
  const noSku = active.filter((p) => p.variants.nodes.some((v) => !v.sku));

  if (drafts.length) push(finding('info', 'catalog', `${drafts.length} produktov v DRAFT stave`));
  if (unpub.length) push(finding('blocker', 'catalog', `${unpub.length} aktívnych produktov nie je publikovaných v Online Store`,
    { priklady: unpub.slice(0, 5).map((p) => p.handle) }));
  // Often a deliberate "gift" variant, so this needs a human call rather than
  // being reported as broken.
  if (zeroPrice.length) push(finding('warn', 'catalog',
    `${zeroPrice.length} variantov s nulovou cenou — over, či je to zámer (darček) alebo chyba`,
    { varianty: zeroPrice.slice(0, 6) }));
  if (noStock.length) push(finding('blocker', 'catalog', `${noStock.length} produktov je vypredaných a nedovoľuje objednávku`,
    { priklady: noStock.slice(0, 5).map((p) => p.handle) }));
  if (noMedia.length) push(finding('blocker', 'catalog', `${noMedia.length} aktívnych produktov nemá hlavný obrázok`,
    { priklady: noMedia.slice(0, 5).map((p) => p.handle) }));
  if (noDesc.length) push(finding('warn', 'catalog', `${noDesc.length} aktívnych produktov nemá popis (<50 znakov)`,
    { priklady: noDesc.slice(0, 5).map((p) => p.handle) }));
  if (noWeight.length) push(finding('warn', 'catalog', `${noWeight.length} produktov nemá váhu — dopravné sadzby podľa hmotnosti zlyhajú`,
    { priklady: noWeight.slice(0, 5).map((p) => p.handle) }));
  if (noSku.length) push(finding('info', 'catalog', `${noSku.length} produktov nemá SKU aspoň na jednom variante`));
  if (noSeo.length) push(finding('info', 'seo', `${noSeo.length} aktívnych produktov nemá SEO popis`));

  // --- language of customer-visible catalog text -------------------------
  const langHits = { product: [], collection: [], page: [], menu: [] };
  for (const p of active) {
    const m = mismatch(`${p.title}. ${p.descriptionHtml ?? ''}`, locale);
    if (m) langHits.product.push({ handle: p.handle, title: p.title, got: m.got });
  }
  for (const c of collections) {
    const m = mismatch(`${c.title}. ${c.descriptionHtml ?? ''}`, locale);
    if (m) langHits.collection.push({ handle: c.handle, title: c.title, got: m.got });
  }
  for (const c of collections) {
    if (!c.descriptionHtml?.trim()) {
      push(finding('info', 'collection', `Kolekcia „${c.title}" nemá popis`));
      break;
    }
  }
  const emptyCollections = collections.filter((c) => (c.productsCount?.count ?? 0) === 0);
  if (emptyCollections.length) {
    push(finding('warn', 'collection', `${emptyCollections.length} prázdnych kolekcií`,
      { kolekcie: emptyCollections.map((c) => c.handle) }));
  }

  // --- content -----------------------------------------------------------
  const c = await graphql(key, CONTENT);
  for (const p of c.pages.nodes) {
    if (!p.isPublished) {
      push(finding('warn', 'page', `Stránka „${p.title}" nie je publikovaná`));
      continue;
    }
    const m = mismatch(`${p.title}. ${p.body ?? ''}`, locale);
    if (m) langHits.page.push({ handle: p.handle, title: p.title, got: m.got });
  }
  for (const menu of c.menus.nodes) {
    const flat = menu.items.flatMap((i) => [i, ...(i.items ?? [])]);
    for (const item of flat) {
      const m = mismatch(item.title, locale);
      if (m) langHits.menu.push({ menu: menu.handle, title: item.title, got: m.got });
    }
    if (!menu.items.length) push(finding('warn', 'menu', `Menu „${menu.title}" je prázdne`));
  }

  const emptyMetaobjects = c.metaobjectDefinitions.nodes.filter((m) => m.metaobjectsCount === 0);
  if (emptyMetaobjects.length) {
    push(finding('warn', 'content', `Metaobjekty bez obsahu: ${emptyMetaobjects.map((m) => m.type).join(', ')}`));
  }

  // --- theme content ------------------------------------------------------
  const th = await graphql(key, THEME_FILES);
  const theme = th.themes.nodes[0];
  const themeHits = [];
  for (const f of theme?.files.nodes ?? []) {
    if (!f.body?.content) continue;
    for (const str of themeStrings(f.body.content)) {
      const m = mismatch(str, locale);
      if (m) themeHits.push({ file: f.filename, got: m.got, text: str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) });
    }
  }
  // A product template only reaches customers if an active product selects it,
  // so an unused template with bad copy is a latent risk, not a live defect.
  const usedSuffixes = new Set(active.map((p) => p.templateSuffix).filter(Boolean));
  const reachable = (file) => {
    const m = file.match(/^templates\/product\.(.+)\.json$/);
    return m ? usedSuffixes.has(m[1]) : true;
  };

  const themeByLang = {};
  for (const h of themeHits) (themeByLang[`${h.got}|${reachable(h.file)}`] ??= []).push(h);
  for (const [tag, hits] of Object.entries(themeByLang)) {
    const [got, live] = tag.split('|');
    const isLive = live === 'true';
    const files = [...new Set(hits.map((h) => h.file))];
    push(finding(got === 'sk' && isLive ? 'blocker' : 'warn', 'theme',
      `${hits.length}× text v téme vyzerá ako ${got.toUpperCase()} namiesto ${locale.toUpperCase()}` +
        (isLive ? ' — šablónu používa aktívny produkt' : ' — šablónu nepoužíva žiadny aktívny produkt'),
      { subory: files, ukazky: [...new Set(hits.map((h) => h.text))].slice(0, 3) }));
  }

  for (const [kind, hits] of Object.entries(langHits)) {
    if (!hits.length) continue;
    const byLang = {};
    for (const h of hits) (byLang[h.got] ??= []).push(h.title);
    for (const [got, titles] of Object.entries(byLang)) {
      push(finding(got === 'sk' ? 'blocker' : 'warn', 'language',
        `${titles.length}× ${kind} vyzerá ako ${got.toUpperCase()} namiesto ${locale.toUpperCase()}`,
        { priklady: titles.slice(0, 6) }));
    }
  }

  return {
    key,
    locale,
    country,
    shop: shop.name,
    domain: shop.primaryDomain.host,
    marketDomain: wp?.domain?.host,
    theme: theme?.name,
    stats: {
      products: products.length,
      active: active.length,
      drafts: drafts.length,
      collections: collections.length,
      pages: c.pages.nodes.length,
      menus: c.menus.nodes.length,
      shippingZones: zones.length,
      activeRates: activeRates.length,
      shipsTo: [...countries],
      wallets: shop.paymentSettings.supportedDigitalWallets ?? [],
      taxesIncluded: shop.taxesIncluded,
      customerAccounts: shop.customerAccountsV2?.customerAccountsVersion,
    },
    findings: out,
  };
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const keys = targets.length ? targets : shopKeys();

const results = [];
for (const key of keys) {
  try {
    results.push(await audit(key));
  } catch (e) {
    results.push({ key, error: e.message });
  }
}

await mkdir('docs', { recursive: true });
await writeFile('docs/launch-audit.json', JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

const ICON = { blocker: '🔴', warn: '🟡', info: '⚪' };
for (const r of results) {
  if (r.error) {
    console.log(`\n### ${r.key.toUpperCase()} — CHYBA: ${r.error}`);
    continue;
  }
  console.log(`\n### ${r.key.toUpperCase()} — ${r.shop} (${r.locale}/${r.country}) ${r.domain}`);
  console.log(`    ${r.stats.active} aktívnych produktov · ${r.stats.collections} kolekcií · ${r.stats.pages} stránok · ` +
    `${r.stats.activeRates} dopravných sadzieb · dane ${r.stats.taxesIncluded ? 'v cene' : 'mimo ceny'}`);
  for (const sev of ['blocker', 'warn', 'info']) {
    for (const f of r.findings.filter((x) => x.sev === sev)) {
      console.log(`  ${ICON[sev]} [${f.area}] ${f.msg}`);
      if (f.detail) console.log(`       ${JSON.stringify(f.detail)}`);
    }
  }
}
console.log('\nFull audit written to docs/launch-audit.json');
