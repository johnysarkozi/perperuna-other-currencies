#!/usr/bin/env node
/**
 * Verifies Shopify credentials for every backend listed in SHOPIFY_SHOPS.
 *
 * For each backend it reports whether the credentials are present, whether a
 * token can actually be minted via the client_credentials grant, which shop the
 * token really resolves to (catches ID/secret swapped between backends), and
 * which scopes the app was granted.
 *
 * Never prints the value of any secret or token.
 */

const API_VERSION = '2025-07';

const shopKeys = (process.env.SHOPIFY_SHOPS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const envName = (key, suffix) => `SHOPIFY_${key.toUpperCase()}_${suffix}`;

function readCredentials(key) {
  const missing = [];
  const values = {};
  for (const suffix of ['SHOP', 'CLIENT_ID', 'CLIENT_SECRET']) {
    const name = envName(key, suffix);
    const value = process.env[name];
    if (!value) missing.push(name);
    values[suffix] = value;
  }
  return { missing, values };
}

async function mintToken({ SHOP, CLIENT_ID, CLIENT_SECRET }) {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

async function identifyShop(shop, token) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: '{ shop { name myshopifyDomain primaryDomain { host } currencyCode ianaTimezone plan { displayName } } }',
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`shop query failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  if (json.errors) throw new Error(`shop query errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json.data.shop;
}

async function checkBackend(key) {
  const { missing, values } = readCredentials(key);
  if (missing.length) return { key, ok: false, reason: `missing env: ${missing.join(', ')}` };

  let grant;
  try {
    grant = await mintToken(values);
  } catch (err) {
    return { key, ok: false, configuredShop: values.SHOP, reason: err.message };
  }

  let shop;
  try {
    shop = await identifyShop(values.SHOP, grant.access_token);
  } catch (err) {
    return { key, ok: false, configuredShop: values.SHOP, scope: grant.scope, reason: err.message };
  }

  // Shopify assigns newer stores a randomized permanent myshopifyDomain, so it
  // often differs from the domain we call. A successful query is the proof the
  // credentials reach a real store; the resolved identity is reported so a
  // swapped ID/secret still shows up as the wrong shop name.
  return {
    key,
    ok: true,
    configuredShop: values.SHOP,
    resolvedShop: shop.myshopifyDomain,
    name: shop.name,
    primaryDomain: shop.primaryDomain?.host,
    currency: shop.currencyCode,
    timezone: shop.ianaTimezone,
    plan: shop.plan?.displayName,
    scope: grant.scope,
    expiresIn: grant.expires_in,
  };
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const targets = requested.length ? requested : shopKeys;

if (!targets.length) {
  console.error('No backends to check. Set SHOPIFY_SHOPS or pass keys as arguments.');
  process.exit(1);
}

const results = await Promise.all(targets.map(checkBackend));

for (const r of results) {
  if (!r.ok) {
    console.log(`✗ ${r.key.padEnd(3)} ${r.configuredShop ?? ''} — ${r.reason}`);
    if (r.resolvedShop && r.resolvedShop !== r.configuredShop) {
      console.log(`      token resolves to ${r.resolvedShop} — ID/secret likely swapped between backends`);
    }
    continue;
  }
  console.log(`✓ ${r.key.padEnd(3)} ${r.configuredShop} (permanent: ${r.resolvedShop})`);
  console.log(`      name=${r.name} domain=${r.primaryDomain} currency=${r.currency} tz=${r.timezone} plan=${r.plan}`);
  const scopes = r.scope ? r.scope.split(',') : [];
  const writes = scopes.filter((s) => s.startsWith('write_')).length;
  console.log(`      token expires_in=${r.expiresIn}s scopes=${scopes.length} (${writes} write)`);
  if (process.argv.includes('--scopes')) console.log(`      ${scopes.join(', ')}`);
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
