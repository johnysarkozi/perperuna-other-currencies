/**
 * product-status — sets a product's status, and spreads that decision when it
 * is one the whole group shares.
 *
 *   { "sku": "PP-CUBE-LOVE-020", "store": "sk", "status": "DRAFT", "password": "…" }
 *   { "sku": "PP-CUBE-CALM-004", "store": "cz", "status": "ARCHIVED",
 *     "productId": "gid://shopify/Product/123", "password": "…" }
 *
 * All four Shopify statuses are reachable:
 *
 *   ACTIVE    on sale
 *   DRAFT     off sale, still in the admin's default view
 *   UNLISTED  reachable only through a direct link — not in search or collections
 *   ARCHIVED  retired; the URL 404s and the product leaves the admin's default view
 *
 * Only ACTIVE and DRAFT are a decision for the whole group, so only those spread
 * from SK to the other backends, and only onto listings that are themselves
 * ACTIVE or DRAFT. UNLISTED and ARCHIVED are decisions about one listing in one
 * market — a discount copy being retired, say — so they stay where they are set.
 * That is also what makes them the way to keep a market deliberately different:
 * inventory-mirror leaves them alone.
 *
 * `productId` names the exact listing to change. Without it the SKU is resolved
 * in that store and a SKU sitting on several products is refused — which is the
 * common case while a catalog still carries campaign copies, and precisely when
 * guessing would be worst.
 *
 * Gated by the same password as inventory-set and price-set: the page carries
 * only the publishable key, and this changes what a live storefront sells.
 */

const API_VERSION = '2026-07';
const ALLOWED = new Set(['ACTIVE', 'DRAFT', 'UNLISTED', 'ARCHIVED']);
/** Statuses that mean "the group sells this or does not" — see above. */
const GROUP = new Set(['ACTIVE', 'DRAFT']);
const SOURCE = 'sk';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

function secretKey(): string {
  const dict = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (dict) {
    const keys = JSON.parse(dict);
    const value = keys.default ?? Object.values(keys)[0];
    if (value) return value as string;
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('no secret key available');
}

function envValue(name: string): string | undefined {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return undefined;
  const prefix = `${name}=`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
}

const PRIMARY_ORIGIN = 'https://multistore-manage-perperuna.netlify.app';

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': origin.endsWith('.netlify.app') ? origin : PRIMARY_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function shopEnv(store: string, suffix: string): string {
  const name = `SHOPIFY_${store.toUpperCase()}_${suffix}`;
  const value = envValue(name);
  if (!value) throw new Error(`missing secret ${name}`);
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function rest(path: string, init: RequestInit = {}) {
  const key = secretKey();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`REST ${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

async function accessToken(store: string): Promise<string> {
  const res = await fetch(`https://${shopEnv(store, 'SHOP')}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: shopEnv(store, 'CLIENT_ID'),
      client_secret: shopEnv(store, 'CLIENT_SECRET'),
    }),
  });
  if (!res.ok) throw new Error(`[${store}] token failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function gql(store: string, token: string, query: string, variables: unknown = {}) {
  const res = await fetch(`https://${shopEnv(store, 'SHOP')}/admin/api/${API_VERSION}/graphql.json`, {
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

const BY_SKU = `query S($q: String!) {
  productVariants(first: 50, query: $q) {
    nodes { sku product { id handle title status } }
  }
}`;

const BY_ID = `query P($id: ID!) {
  product(id: $id) {
    id handle title status
    variants(first: 50) { nodes { sku } }
  }
}`;

// `input:` is deprecated from 2025-10 onwards; `product:` is the current shape.
const UPDATE = `mutation P($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id handle status }
    userErrors { field message }
  }
}`;

type Product = { id: string; handle: string; title: string; status: string };
type Applied =
  | { changed: boolean; status: string; previous: string; handle: string; productId: string }
  | { changed: false; skipped: string; detail?: string };

/** Every product in one store carrying exactly this SKU. */
async function productsWithSku(store: string, token: string, sku: string): Promise<Product[]> {
  const data = await gql(store, token, BY_SKU, { q: `sku:${sku}` });
  // Shopify's sku: search is a prefix/token match, so pin it to an exact hit.
  const products = new Map<string, Product>();
  for (const v of data.productVariants.nodes) {
    if (v.sku?.trim() !== sku) continue;
    products.set(v.product.id, v.product);
  }
  return [...products.values()];
}

/**
 * Set one product's status.
 *
 * `productId` is the caller pointing at the exact listing it had on screen.
 * Without it the SKU is resolved here: `spreading` picks only among listings the
 * group shares (ACTIVE/DRAFT), because that is the only case where SK speaks for
 * another market; anything ambiguous is reported rather than guessed.
 */
async function applyStatus(
  store: string,
  sku: string,
  status: string,
  opts: { strict: boolean; productId?: string; spreading?: boolean },
): Promise<Applied> {
  const token = await accessToken(store);
  let product: Product | undefined;

  if (opts.productId) {
    const data = await gql(store, token, BY_ID, { id: opts.productId });
    if (!data.product) throw new Error(`[${store}] product ${opts.productId} does not exist`);
    const carries = data.product.variants.nodes.some((v: { sku: string | null }) => v.sku?.trim() === sku);
    if (!carries) throw new Error(`[${store}] product ${data.product.handle} does not carry SKU ${sku}`);
    product = data.product;
  } else {
    const found = await productsWithSku(store, token, sku);
    const candidates = opts.spreading ? found.filter((p) => GROUP.has(p.status)) : found;

    if (!candidates.length) {
      if (opts.strict) throw new Error(`SKU ${sku} is not in ${store.toUpperCase()}`);
      return { changed: false, skipped: found.length ? 'not-switchable' : 'absent' };
    }
    if (candidates.length > 1) {
      // Several live listings on one SKU is the catalog problem itself; picking
      // one at random would be worse than saying so.
      const handles = candidates.map((p) => p.handle).join(', ');
      if (opts.strict) {
        throw new Error(
          `SKU ${sku} sedí v ${store.toUpperCase()} na ${candidates.length} produktoch (${handles}) — ` +
          `vyber konkrétny listing v pohľade na obchod`,
        );
      }
      return { changed: false, skipped: 'ambiguous', detail: handles };
    }
    product = candidates[0];
  }

  if (product.status === status) {
    return { changed: false, status, previous: product.status, handle: product.handle, productId: product.id };
  }

  const res = await gql(store, token, UPDATE, { product: { id: product.id, status } });
  const errs = res.productUpdate.userErrors;
  if (errs.length) throw new Error(`[${store}] update failed: ${JSON.stringify(errs).slice(0, 300)}`);

  return { changed: true, status, previous: product.status, handle: product.handle, productId: product.id };
}

Deno.serve(async (req) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const body = await req.json();
    const sku = String(body.sku ?? '').trim();
    const store = String(body.store ?? '').trim().toLowerCase();
    const status = String(body.status ?? '').trim().toUpperCase();
    const password = String(body.password ?? '');
    const productId = body.productId ? String(body.productId).trim() : undefined;

    if (!sku) throw new Error('sku is required');
    if (!/^[a-z]{2}$/.test(store)) throw new Error('store must be a two-letter backend key');
    if (!ALLOWED.has(status)) throw new Error(`status must be one of ${[...ALLOWED].join(', ')}`);
    if (productId && !/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
      throw new Error('productId is not a Shopify product gid');
    }

    const configured = (envValue('SHOPIFY_SHOPS') ?? '')
      .split(',').map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => /^[a-z]{2}$/.test(s));
    if (!configured.includes(store)) throw new Error(`unknown backend ${store}`);

    const rows = await rest('catalog_settings?key=eq.edit_password_sha256&select=value');
    const expected = rows?.[0]?.value;
    if (!expected) throw new Error('edit password is not configured');
    if (await sha256Hex(password) !== expected) {
      return Response.json({ ok: false, error: 'Nesprávne heslo' }, { status: 403, headers });
    }

    // The clicked store goes first: if it fails, nothing else is touched and
    // the backends stay consistent with each other.
    const primary = await applyStatus(store, sku, status, { strict: true, productId });
    const results: Record<string, Applied> = { [store]: primary };

    // Switching the group on or off from SK is a decision for every market, so
    // it is spread now rather than 15 minutes from now. Unlisting or archiving
    // is about one listing, so it stays here.
    const spread = store === SOURCE && GROUP.has(status)
      ? configured.filter((s: string) => s !== SOURCE)
      : [];
    for (const other of spread) {
      results[other] = await applyStatus(other, sku, status, { strict: false, spreading: true });
    }

    const written = Object.entries(results).filter(([, r]) => r.changed);

    // Keep the catalog copy in step so the dots move without waiting for a sync.
    for (const [key, r] of written) {
      const id = (r as { productId: string }).productId;
      await rest(
        `catalog_listings?shopify_product_id=eq.${encodeURIComponent(id)}&store=eq.${encodeURIComponent(key)}`,
        { method: 'PATCH', body: JSON.stringify({ status }), headers: { Prefer: 'return=minimal' } },
      );
    }

    if (written.length) {
      await rest('catalog_sync_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(written.map(([key, r]) => ({
          direction: 'push', store: key, sku, field: 'status',
          old_value: (r as { previous: string }).previous, new_value: status, actor: 'product-status',
        }))),
      });
    }

    return Response.json({
      ok: true,
      sku,
      store,
      status,
      changed: primary.changed,
      handle: 'handle' in primary ? primary.handle : undefined,
      previous: 'previous' in primary ? primary.previous : undefined,
      spread: spread.length > 0,
      // Which listings now carry this status, so the dashboard can move them
      // instead of waiting for the next sync.
      applied: Object.entries(results)
        .filter(([, r]) => 'productId' in r)
        .map(([key, r]) => ({ store: key, productId: (r as { productId: string }).productId })),
      stores: results,
    }, { headers });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500, headers });
  }
});
