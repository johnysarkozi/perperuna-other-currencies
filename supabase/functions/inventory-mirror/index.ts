/**
 * inventory-mirror — copies stock from SK onto the other backends, matched by
 * SKU. Server-side twin of scripts/inventory-mirror.mjs, so it can run on a
 * schedule without anything on a laptop.
 *
 *   {}                      -> mirror every backend in SHOPIFY_SHOPS except sk
 *   { "stores": ["pl"] }    -> just these
 *   { "dryRun": true }      -> report what would change, write nothing
 *
 * Every write is recorded in catalog_sync_log, so the history of what this
 * changed is queryable after the fact.
 */

const API_VERSION = '2025-07';
const PAGE_SIZE = 100;
const BATCH = 100;
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

/** Read a secret, tolerating a whole `NAME=value` line pasted into the value. */
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

const VARIANTS = `query V($first: Int!, $after: String) {
  productVariants(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku title
      product { id handle status }
      inventoryItem {
        id tracked
        inventoryLevels(first: 5) {
          nodes { location { id } quantities(names: ["available"]) { name quantity } }
        }
      }
    }
  }
}`;

type Row = {
  sku: string; variantId: string; productId: string; inventoryItemId: string;
  handle: string; status: string; variantTitle: string; available: number | null;
};

async function readStore(store: string) {
  const token = await accessToken(store);

  const locData = await gql(store, token, '{ locations(first: 10) { nodes { id name isActive } } }');
  const active = locData.locations.nodes.filter((l: { isActive: boolean }) => l.isActive);
  if (active.length !== 1) throw new Error(`[${store}] expected one active location, found ${active.length}`);
  const location = active[0];

  const rows: Row[] = [];
  const untracked: Row[] = [];
  let after: string | null = null;

  for (;;) {
    const data = await gql(store, token, VARIANTS, { first: PAGE_SIZE, after });
    for (const v of data.productVariants.nodes) {
      const sku = v.sku?.trim();
      if (!sku) continue;
      const level = v.inventoryItem.inventoryLevels.nodes
        .find((l: { location: { id: string } }) => l.location.id === location.id);
      const row: Row = {
        sku,
        variantId: v.id,
        productId: v.product.id,
        inventoryItemId: v.inventoryItem.id,
        handle: v.product.handle,
        status: v.product.status,
        variantTitle: v.title,
        available: level?.quantities?.find((q: { name: string }) => q.name === 'available')?.quantity ?? null,
      };
      (v.inventoryItem.tracked ? rows : untracked).push(row);
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  return { token, location, rows, untracked };
}

const SET = `mutation Set($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    userErrors { field message code }
  }
}`;

async function logChanges(rows: unknown[]) {
  if (!rows.length) return;
  const key = secretKey();
  for (let i = 0; i < rows.length; i += BATCH) {
    await fetch(`${SUPABASE_URL}/rest/v1/catalog_sync_log`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
  }
}

Deno.serve(async (req) => {
  try {
    const body = req.headers.get('content-type')?.includes('json') ? await req.json() : {};
    const dryRun = body.dryRun === true;
    const configured = (envValue('SHOPIFY_SHOPS') ?? 'cz,ro,pl,hu')
      .split(',').map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => /^[a-z]{2}$/.test(s));
    const stores: string[] = (body.stores?.length ? body.stores : configured)
      .filter((s: string) => s !== SOURCE);

    // SK can carry a SKU on several listings — usually a live product plus an
    // archived discount copy holding stale numbers. The live one is authoritative.
    const source = await readStore(SOURCE);
    const truth = new Map<string, number>();
    for (const r of source.rows) {
      if (r.available === null) continue;
      const prev = truth.get(r.sku);
      if (prev === undefined || r.status === 'ACTIVE') truth.set(r.sku, r.available);
    }

    const report: Record<string, unknown> = {};
    const logRows: unknown[] = [];
    let totalWritten = 0;

    for (const store of stores) {
      const target = await readStore(store);
      const changes = target.rows.filter((r) => truth.has(r.sku) && truth.get(r.sku) !== r.available);
      const untrackedOnSk = target.untracked.filter((r) => truth.has(r.sku)).length;

      let written = 0;
      if (!dryRun && changes.length) {
        for (let i = 0; i < changes.length; i += BATCH) {
          const slice = changes.slice(i, i + BATCH);
          const res = await gql(store, target.token, SET, {
            input: {
              reason: 'correction',
              name: 'available',
              referenceDocumentUri: `gid://perperuna-catalog/InventoryMirror/${new Date().toISOString()}`,
              ignoreCompareQuantity: true,
              quantities: slice.map((c) => ({
                inventoryItemId: c.inventoryItemId,
                locationId: target.location.id,
                quantity: truth.get(c.sku)!,
              })),
            },
          });
          const errs = res.inventorySetQuantities.userErrors;
          if (errs.length) throw new Error(`[${store}] set failed: ${JSON.stringify(errs).slice(0, 300)}`);
          written += slice.length;
          for (const c of slice) {
            logRows.push({
              direction: 'push',
              store,
              sku: c.sku,
              field: 'inventory_quantity',
              old_value: String(c.available),
              new_value: String(truth.get(c.sku)),
              actor: 'inventory-mirror',
            });
          }
        }
      }

      totalWritten += written;
      report[store] = {
        tracked: target.rows.length,
        changed: changes.length,
        written,
        untrackedButOnSk: untrackedOnSk,
      };
    }

    await logChanges(logRows);

    return Response.json({
      ok: true,
      dryRun,
      source: { skus: truth.size, variants: source.rows.length },
      stores: report,
      written: totalWritten,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
