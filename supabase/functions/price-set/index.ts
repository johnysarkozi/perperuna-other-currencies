/**
 * price-set — sets the price and the compare-at price of one SKU, on as many
 * backends as the caller sends in one request.
 *
 *   {
 *     "sku": "PP-CUBE-CALM-004",
 *     "changes": [
 *       { "store": "sk", "variantId": "gid://shopify/ProductVariant/1", "price": 4.49, "compareAtPrice": 5.99 },
 *       { "store": "cz", "variantId": "gid://shopify/ProductVariant/2", "price": 109 }
 *     ],
 *     "password": "…"
 *   }
 *
 * Unlike stock and on/off state, price is NOT mirrored from SK: every backend
 * has its own currency and its own price level, so there is no single number to
 * copy. The dashboard converts through the ECB rate to suggest values, but what
 * is sent here is always the explicit per-market figure a person approved.
 *
 * Each change names the variant it edits, taken from the catalog row the person
 * was looking at, and the variant's SKU is verified before anything is written
 * — a SKU can sit on several products in one store (discount copies), and
 * guessing which of them to reprice would be worse than refusing.
 *
 * `compareAtPrice: null` clears the compare-at price (no strikethrough);
 * leaving the key out keeps whatever the variant has.
 *
 * Gated by the same password as inventory-set and product-status: the page
 * carries only the publishable key, and this changes what customers pay.
 */

const API_VERSION = '2025-07';
const MAX_PRICE = 10_000_000;

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

const VARIANT = `query V($id: ID!) {
  productVariant(id: $id) {
    id sku price compareAtPrice
    product { id title status }
  }
}`;

const UPDATE = `mutation P($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price compareAtPrice }
    userErrors { field message }
  }
}`;

type Change = {
  store: string;
  variantId: string;
  price?: number;
  compareAtPrice?: number | null;
};

/** A price as Shopify wants it: a decimal string, never a float in JSON. */
const asMoney = (v: number) => v.toFixed(2);

function validate(change: Change) {
  if (!/^[a-z]{2}$/.test(change.store)) throw new Error('store must be a two-letter backend key');
  if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(change.variantId)) {
    throw new Error(`[${change.store}] variantId is not a Shopify variant gid`);
  }
  const hasPrice = change.price !== undefined;
  const hasCompare = change.compareAtPrice !== undefined;
  if (!hasPrice && !hasCompare) throw new Error(`[${change.store}] nothing to change`);

  if (hasPrice && (!Number.isFinite(change.price!) || change.price! < 0 || change.price! > MAX_PRICE)) {
    throw new Error(`[${change.store}] price must be between 0 and ${MAX_PRICE}`);
  }
  if (hasCompare && change.compareAtPrice !== null) {
    const compare = change.compareAtPrice!;
    if (!Number.isFinite(compare) || compare <= 0 || compare > MAX_PRICE) {
      throw new Error(`[${change.store}] compare-at price must be between 0 and ${MAX_PRICE}`);
    }
  }
}

Deno.serve(async (req) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const body = await req.json();
    const sku = String(body.sku ?? '').trim();
    const password = String(body.password ?? '');
    const changes: Change[] = Array.isArray(body.changes) ? body.changes : [];

    if (!sku) throw new Error('sku is required');
    if (!changes.length) throw new Error('changes is required');
    if (changes.length > 10) throw new Error('too many changes in one request');

    const configured = (envValue('SHOPIFY_SHOPS') ?? '')
      .split(',').map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => /^[a-z]{2}$/.test(s));

    for (const change of changes) {
      validate(change);
      if (!configured.includes(change.store)) throw new Error(`unknown backend ${change.store}`);
    }
    if (new Set(changes.map((c) => c.store)).size !== changes.length) {
      throw new Error('one backend appears twice in the same request');
    }

    const rows = await rest('catalog_settings?key=eq.edit_password_sha256&select=value');
    const expected = rows?.[0]?.value;
    if (!expected) throw new Error('edit password is not configured');
    if (await sha256Hex(password) !== expected) {
      return Response.json({ ok: false, error: 'Nesprávne heslo' }, { status: 403, headers });
    }

    // Everything is read and checked before the first write, so a typo in the
    // last market does not leave the earlier ones already repriced.
    const planned: {
      change: Change; token: string; productId: string;
      previous: { price: number; compareAtPrice: number | null };
      next: { price: number; compareAtPrice: number | null };
    }[] = [];

    for (const change of changes) {
      const token = await accessToken(change.store);
      const data = await gql(change.store, token, VARIANT, { id: change.variantId });
      const variant = data.productVariant;
      if (!variant) throw new Error(`[${change.store}] variant ${change.variantId} does not exist`);
      if (variant.sku?.trim() !== sku) {
        throw new Error(`[${change.store}] variant carries SKU ${variant.sku ?? '—'}, not ${sku}`);
      }

      const previous = {
        price: Number(variant.price),
        compareAtPrice: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
      };
      const next = {
        price: change.price ?? previous.price,
        compareAtPrice: change.compareAtPrice === undefined ? previous.compareAtPrice : change.compareAtPrice,
      };

      // A compare-at below the price shows no strikethrough and just looks
      // broken in the storefront, so it is refused rather than written.
      if (next.compareAtPrice !== null && next.compareAtPrice < next.price) {
        throw new Error(
          `[${change.store}] cena pred zľavou (${next.compareAtPrice}) je nižšia než cena (${next.price})`,
        );
      }

      planned.push({ change, token, productId: variant.product.id, previous, next });
    }

    const results: Record<string, unknown> = {};
    const logRows: unknown[] = [];

    for (const step of planned) {
      const { change, previous, next } = step;
      const changedPrice = next.price !== previous.price;
      const changedCompare = next.compareAtPrice !== previous.compareAtPrice;

      if (!changedPrice && !changedCompare) {
        results[change.store] = { changed: false, ...previous };
        continue;
      }

      const res = await gql(change.store, step.token, UPDATE, {
        productId: step.productId,
        variants: [{
          id: change.variantId,
          ...(changedPrice ? { price: asMoney(next.price) } : {}),
          ...(changedCompare ? { compareAtPrice: next.compareAtPrice === null ? null : asMoney(next.compareAtPrice) } : {}),
        }],
      });
      const errs = res.productVariantsBulkUpdate.userErrors;
      if (errs.length) throw new Error(`[${change.store}] update failed: ${JSON.stringify(errs).slice(0, 300)}`);

      results[change.store] = { changed: true, previous, ...next };

      // Keep the catalog copy in step so the table shows the new figures
      // without waiting for the next sync.
      await rest(
        `catalog_listings?shopify_variant_id=eq.${encodeURIComponent(change.variantId)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ price: next.price, compare_at_price: next.compareAtPrice }),
        },
      );

      if (changedPrice) {
        logRows.push({
          direction: 'push', store: change.store, sku, field: 'price',
          old_value: String(previous.price), new_value: String(next.price), actor: 'price-set',
        });
      }
      if (changedCompare) {
        logRows.push({
          direction: 'push', store: change.store, sku, field: 'compare_at_price',
          old_value: previous.compareAtPrice === null ? null : String(previous.compareAtPrice),
          new_value: next.compareAtPrice === null ? null : String(next.compareAtPrice),
          actor: 'price-set',
        });
      }
    }

    if (logRows.length) {
      await rest('catalog_sync_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(logRows),
      });
    }

    return Response.json({ ok: true, sku, stores: results, written: logRows.length }, { headers });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500, headers });
  }
});
