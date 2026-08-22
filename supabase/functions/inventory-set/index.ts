/**
 * inventory-set — sets stock for one SKU on SK and immediately pushes the same
 * number to the other backends.
 *
 *   { "sku": "PP-CUBE-CALM-004", "quantity": 120, "password": "…" }
 *
 * Why a password: the page reaches Supabase with the publishable key, which is
 * visible in its source. That is fine for reading the catalog, but this
 * endpoint changes production inventory on five stores, so it is gated by a
 * separate secret held in catalog_settings and never shipped to the browser.
 */

const API_VERSION = '2025-07';
const SOURCE = 'sk';
const MAX_QUANTITY = 1_000_000;

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
  productVariants(first: 30, query: $q) {
    nodes {
      id
      product { handle status }
      inventoryItem {
        id tracked
        inventoryLevels(first: 5) {
          nodes { location { id } quantities(names: ["available"]) { name quantity } }
        }
      }
    }
  }
}`;

const SET = `mutation Set($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) { userErrors { field message code } }
}`;

/** Set every tracked variant carrying this SKU in one store to `quantity`. */
async function setInStore(store: string, sku: string, quantity: number) {
  const token = await accessToken(store);

  const locData = await gql(store, token, '{ locations(first: 10) { nodes { id isActive } } }');
  const active = locData.locations.nodes.filter((l: { isActive: boolean }) => l.isActive);
  if (active.length !== 1) throw new Error(`[${store}] expected one active location, found ${active.length}`);
  const locationId = active[0].id;

  const data = await gql(store, token, BY_SKU, { q: `sku:${sku}` });
  const variants = data.productVariants.nodes.filter((v: { inventoryItem: { tracked: boolean } }) => v.inventoryItem.tracked);
  if (!variants.length) return { changed: 0, previous: null as number | null };

  const previous = variants[0].inventoryItem.inventoryLevels.nodes
    .find((l: { location: { id: string } }) => l.location.id === locationId)
    ?.quantities?.find((q: { name: string }) => q.name === 'available')?.quantity ?? null;

  const res = await gql(store, token, SET, {
    input: {
      reason: 'correction',
      name: 'available',
      referenceDocumentUri: `gid://perperuna-catalog/InventorySet/${new Date().toISOString()}`,
      ignoreCompareQuantity: true,
      quantities: variants.map((v: { inventoryItem: { id: string } }) => ({
        inventoryItemId: v.inventoryItem.id,
        locationId,
        quantity,
      })),
    },
  });
  const errs = res.inventorySetQuantities.userErrors;
  if (errs.length) throw new Error(`[${store}] set failed: ${JSON.stringify(errs).slice(0, 300)}`);

  return { changed: variants.length, previous };
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const sku = String(body.sku ?? '').trim();
    const quantity = Number(body.quantity);
    const password = String(body.password ?? '');

    if (!sku) throw new Error('sku is required');
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
      throw new Error(`quantity must be a whole number between 0 and ${MAX_QUANTITY}`);
    }

    const rows = await rest('catalog_settings?key=eq.edit_password_sha256&select=value');
    const expected = rows?.[0]?.value;
    if (!expected) throw new Error('edit password is not configured');
    if (await sha256Hex(password) !== expected) {
      return Response.json({ ok: false, error: 'Nesprávne heslo' }, { status: 403 });
    }

    // The SKU has to already exist in the catalog — this endpoint adjusts
    // stock, it never invents products.
    const known = await rest(`catalog_listings?sku=eq.${encodeURIComponent(sku)}&select=sku&limit=1`);
    if (!known?.length) throw new Error(`unknown SKU ${sku}`);

    const configured = (envValue('SHOPIFY_SHOPS') ?? 'cz,ro,pl,hu')
      .split(',').map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => /^[a-z]{2}$/.test(s));

    // SK first: if it fails, nothing else is touched and the stores stay
    // consistent with each other.
    const source = await setInStore(SOURCE, sku, quantity);
    const results: Record<string, unknown> = { [SOURCE]: source };
    const logRows: unknown[] = [{
      direction: 'push', store: SOURCE, sku, field: 'inventory_quantity',
      old_value: String(source.previous), new_value: String(quantity), actor: 'inventory-set',
    }];

    for (const store of configured.filter((s: string) => s !== SOURCE)) {
      const r = await setInStore(store, sku, quantity);
      results[store] = r;
      if (r.changed) {
        logRows.push({
          direction: 'push', store, sku, field: 'inventory_quantity',
          old_value: String(r.previous), new_value: String(quantity), actor: 'inventory-set',
        });
      }
    }

    await rest('catalog_sync_log', {
      method: 'POST',
      body: JSON.stringify(logRows),
      headers: { Prefer: 'return=minimal' },
    });

    return Response.json({ ok: true, sku, quantity, stores: results });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
