/**
 * catalog-sync — pulls product/price/inventory data from every Shopify backend
 * into the shared catalog tables.
 *
 * Runs server-side so no credential ever reaches a browser or a local script:
 * Shopify client credentials come from this function's own secrets, and the
 * Supabase service role key is injected by the platform.
 *
 * Invoke with an optional body to narrow the run:
 *   {}                      -> every backend in SHOPIFY_SHOPS except sk
 *   { "stores": ["pl"] }    -> just these
 */

const API_VERSION = '2025-07';
const PAGE_SIZE = 50;
const UPSERT_CHUNK = 100;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

/**
 * The key that bypasses RLS, under either naming scheme: projects on the newer
 * API keys expose SUPABASE_SECRET_KEYS (a JSON dictionary), older ones expose
 * SUPABASE_SERVICE_ROLE_KEY directly.
 */
function secretKey(): string {
  const dict = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (dict) {
    const keys = JSON.parse(dict);
    const value = keys.default ?? Object.values(keys)[0];
    if (value) return value as string;
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('no secret key available (checked SUPABASE_SECRET_KEYS and SUPABASE_SERVICE_ROLE_KEY)');
}

type Listing = Record<string, unknown>;

/**
 * Read a secret, tolerating a whole `NAME=value` line pasted into the value
 * field — an easy slip when copying a block of secrets into the dashboard.
 */
function envValue(name: string): string | undefined {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return undefined;
  const prefix = `${name}=`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
}

function shopEnv(store: string, suffix: string): string {
  const name = `SHOPIFY_${store.toUpperCase()}_${suffix}`;
  const value = envValue(name);
  if (!value) throw new Error(`missing secret ${name}`);
  return value;
}

/** Exchange client credentials for a short-lived Admin API token. */
async function accessToken(store: string): Promise<string> {
  const shop = shopEnv(store, 'SHOP');
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: shopEnv(store, 'CLIENT_ID'),
      client_secret: shopEnv(store, 'CLIENT_SECRET'),
    }),
  });
  if (!res.ok) throw new Error(`[${store}] token failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function shopifyGraphql(store: string, token: string, query: string, variables: unknown = {}) {
  const shop = shopEnv(store, 'SHOP');
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`[${store}] HTTP ${res.status}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  if (json.errors) throw new Error(`[${store}] GraphQL: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json.data;
}

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

async function readStore(store: string): Promise<Listing[]> {
  const token = await accessToken(store);
  const { shop } = await shopifyGraphql(store, token, '{ shop { currencyCode } }');

  const listings: Listing[] = [];
  let after: string | null = null;

  for (;;) {
    const data = await shopifyGraphql(store, token, PRODUCTS, { first: PAGE_SIZE, after });
    for (const p of data.products.nodes) {
      for (const v of p.variants.nodes) {
        const sku = v.sku?.trim();
        if (!sku) continue;
        const available = v.inventoryItem?.inventoryLevels?.nodes?.[0]
          ?.quantities?.find((q: { name: string }) => q.name === 'available');
        listings.push({
          sku,
          store,
          shopify_product_id: p.id,
          shopify_variant_id: v.id,
          handle: p.handle,
          title: p.title,
          variant_title: v.title,
          status: p.status,
          currency: shop.currencyCode,
          price: v.price === null ? null : Number(v.price),
          compare_at_price: v.compareAtPrice === null ? null : Number(v.compareAtPrice),
          inventory_item_id: v.inventoryItem?.id ?? null,
          inventory_quantity: available ? available.quantity : null,
          inventory_policy: v.inventoryPolicy,
          image_url: p.featuredMedia?.preview?.image?.url ?? null,
          synced_at: new Date().toISOString(),
        });
      }
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }

  return listings;
}

async function upsert(table: string, rows: unknown[], onConflict: string, key: string) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows.slice(i, i + UPSERT_CHUNK)),
      },
    );
    if (!res.ok) throw new Error(`upsert ${table} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

Deno.serve(async (req) => {
  try {
    const body = req.headers.get('content-type')?.includes('json') ? await req.json() : {};
    const configured = (envValue('SHOPIFY_SHOPS') ?? 'cz,ro,pl,hu')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      // Backend keys are two-letter codes; anything else is a malformed secret.
      .filter((s) => /^[a-z]{2}$/.test(s));
    if (!configured.length) throw new Error('SHOPIFY_SHOPS has no valid two-letter backend codes');

    // Diagnostic: report which secrets are set, never their values.
    if (body.check) {
      const present: Record<string, boolean> = { SHOPIFY_SHOPS: !!envValue('SHOPIFY_SHOPS') };
      for (const s of ['sk', 'cz', 'ro', 'pl', 'hu']) {
        for (const suffix of ['SHOP', 'CLIENT_ID', 'CLIENT_SECRET']) {
          const name = `SHOPIFY_${s.toUpperCase()}_${suffix}`;
          present[name] = !!envValue(name);
        }
      }
      return Response.json({ ok: true, parsedStores: configured, secretsPresent: present });
    }

    const stores: string[] = body.stores?.length ? body.stores : configured.filter((s) => s !== 'sk');

    const perStore: Record<string, number> = {};
    const all: Listing[] = [];
    for (const store of stores) {
      const rows = await readStore(store);
      perStore[store] = rows.length;
      all.push(...rows);
    }

    const key = secretKey();
    const skus = [...new Set(all.map((r) => r.sku as string))];
    await upsert('catalog_products', skus.map((sku) => ({ sku })), 'sku', key);
    await upsert('catalog_listings', all, 'store,shopify_variant_id', key);

    return Response.json({ ok: true, stores: perStore, skus: skus.length, listings: all.length });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
