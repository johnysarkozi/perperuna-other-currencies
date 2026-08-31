/**
 * product-status — turns one SKU on or off, and spreads that decision.
 *
 *   { "sku": "PP-CUBE-LOVE-020", "store": "sk", "status": "DRAFT", "password": "…" }
 *
 * SK is the source of truth for the on/off state just as it is for stock, so a
 * switch on SK is applied to every other backend right away rather than waiting
 * for the next mirror run. A switch on any other backend touches only that one
 * — but inventory-mirror would put it back within 15 minutes, which is why the
 * dashboard only offers the SK dot.
 *
 * Only ACTIVE and DRAFT are accepted as targets: those are the two states the
 * dashboard's dot toggles between. ARCHIVED is deliberately not reachable from
 * here — archiving is a catalog decision, not a switch, and it hides the
 * product from the Shopify admin's default view where nobody would find it
 * again by accident. For the same reason a foreign product that is UNLISTED or
 * ARCHIVED is left alone when SK is switched: those listings (the "-25 %"
 * copies among them) are their own decision.
 *
 * Gated by the same password as inventory-set, for the same reason: the page
 * carries only the publishable key, and this changes what a live storefront
 * sells.
 */

const API_VERSION = '2025-07';
const ALLOWED = new Set(['ACTIVE', 'DRAFT']);
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

const UPDATE = `mutation P($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id handle status }
    userErrors { field message }
  }
}`;

type Applied =
  | { changed: boolean; status: string; previous: string; handle: string }
  | { changed: false; skipped: string; detail?: string };

/**
 * Set one SKU's product to `status` in one store.
 *
 * `strict` is for the store the person actually clicked: there, anything that
 * stops the write — the SKU missing, or sitting on several products — is an
 * error they need to see. When the same change is being spread to the other
 * backends those are ordinary facts about a catalog that is not identical
 * everywhere, so they are reported as skips instead of failing the request.
 */
async function applyStatus(store: string, sku: string, status: string, strict: boolean): Promise<Applied> {
  const token = await accessToken(store);
  const data = await gql(store, token, BY_SKU, { q: `sku:${sku}` });

  // Shopify's sku: search is a prefix/token match, so pin it to an exact hit.
  const products = new Map<string, { id: string; handle: string; title: string; status: string }>();
  for (const v of data.productVariants.nodes) {
    if (v.sku?.trim() !== sku) continue;
    products.set(v.product.id, v.product);
  }

  if (!products.size) {
    if (strict) throw new Error(`SKU ${sku} is not in ${store.toUpperCase()}`);
    return { changed: false, skipped: 'absent' };
  }

  // UNLISTED and ARCHIVED listings are not switches — see the header.
  const switchable = [...products.values()].filter((p) => ALLOWED.has(p.status));
  if (!switchable.length) {
    const states = [...products.values()].map((p) => p.status).join(', ');
    if (strict) throw new Error(`SKU ${sku} in ${store.toUpperCase()} is ${states}, which this does not switch`);
    return { changed: false, skipped: 'not-switchable', detail: states };
  }
  if (switchable.length > 1) {
    // Two live products sharing a SKU is a data problem in itself; flipping a
    // guessed one would be worse than refusing.
    const handles = switchable.map((p) => p.handle).join(', ');
    if (strict) {
      throw new Error(
        `SKU ${sku} sits on ${switchable.length} products in ${store.toUpperCase()} (${handles}) — fix that first`,
      );
    }
    return { changed: false, skipped: 'ambiguous', detail: handles };
  }

  const product = switchable[0];
  if (product.status === status) {
    return { changed: false, status, previous: product.status, handle: product.handle };
  }

  const res = await gql(store, token, UPDATE, { input: { id: product.id, status } });
  const errs = res.productUpdate.userErrors;
  if (errs.length) throw new Error(`[${store}] update failed: ${JSON.stringify(errs).slice(0, 300)}`);

  return { changed: true, status, previous: product.status, handle: product.handle };
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

    if (!sku) throw new Error('sku is required');
    if (!/^[a-z]{2}$/.test(store)) throw new Error('store must be a two-letter backend key');
    if (!ALLOWED.has(status)) throw new Error(`status must be one of ${[...ALLOWED].join(', ')}`);

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
    const primary = await applyStatus(store, sku, status, true);
    const results: Record<string, Applied> = { [store]: primary };

    // A switch on SK is a decision for the whole group, so it is spread now
    // rather than 15 minutes from now. A switch anywhere else stays local.
    const mirrored = store === SOURCE
      ? configured.filter((s: string) => s !== SOURCE)
      : [];
    for (const other of mirrored) {
      results[other] = await applyStatus(other, sku, status, false);
    }

    const written = Object.entries(results).filter(([, r]) => r.changed);

    // Keep the catalog copy in step so the dots flip without waiting for a sync.
    // Only the listings that were actually switched, so an unlisted or archived
    // copy of the same SKU keeps showing its real state.
    for (const [key] of written) {
      await rest(
        `catalog_listings?sku=eq.${encodeURIComponent(sku)}&store=eq.${encodeURIComponent(key)}` +
        `&status=in.(${[...ALLOWED].join(',')})`,
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
      mirrored: store === SOURCE,
      // Which backends now carry this state, so the dashboard can move their
      // dots too instead of waiting for the next sync.
      applied: Object.keys(results).filter((key) => {
        const r = results[key];
        return r.changed || 'handle' in r;
      }),
      stores: results,
    }, { headers });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500, headers });
  }
});
