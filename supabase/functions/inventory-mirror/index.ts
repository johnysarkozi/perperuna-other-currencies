/**
 * inventory-mirror — copies stock *and* on/off state from SK onto the other
 * backends, matched by SKU. Server-side twin of scripts/inventory-mirror.mjs,
 * so it can run on a schedule without anything on a laptop.
 *
 *   {}                      -> mirror every backend in SHOPIFY_SHOPS except sk
 *   { "stores": ["pl"] }    -> just these
 *   { "dryRun": true }      -> report what would change, write nothing
 *
 * Status mirroring only ever moves a product between ACTIVE and DRAFT, on both
 * ends: an SK product that is UNLISTED or ARCHIVED says nothing about the other
 * markets, and a foreign product in one of those states is a deliberate
 * decision about that listing (the "-25 %" discount copies live there), not a
 * switch this may flip.
 *
 * Every write is recorded in catalog_sync_log, so the history of what this
 * changed is queryable after the fact.
 */

const API_VERSION = '2025-07';
const PAGE_SIZE = 100;
const BATCH = 100;
const SOURCE = 'sk';

/** The two states that count as "switched on / switched off" — see above. */
const MIRRORED = new Set(['ACTIVE', 'DRAFT']);

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

// The dashboard calls this from a browser, which sends a preflight before any
// POST carrying an Authorization header. Without these the request never
// leaves the browser and surfaces only as "Failed to fetch".
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

/** A product as the status mirror sees it: one state, and the SKUs under it. */
type Listing = { id: string; handle: string; status: string; skus: Set<string> };

async function readStore(store: string) {
  const token = await accessToken(store);

  const locData = await gql(store, token, '{ locations(first: 10) { nodes { id name isActive } } }');
  const active = locData.locations.nodes.filter((l: { isActive: boolean }) => l.isActive);
  if (active.length !== 1) throw new Error(`[${store}] expected one active location, found ${active.length}`);
  const location = active[0];

  const rows: Row[] = [];
  const untracked: Row[] = [];
  // Status lives on the product, so it is collected per product rather than per
  // variant — and unlike stock it applies to untracked variants (FEE-* and the
  // like) just as much.
  const listings = new Map<string, Listing>();
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

      let listing = listings.get(v.product.id);
      if (!listing) {
        listing = { id: v.product.id, handle: v.product.handle, status: v.product.status, skus: new Set() };
        listings.set(v.product.id, listing);
      }
      listing.skus.add(sku);
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  return { token, location, rows, untracked, listings };
}

const SET = `mutation Set($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    userErrors { field message code }
  }
}`;

const UPDATE_STATUS = `mutation P($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id status }
    userErrors { field message }
  }
}`;

/**
 * What SK says each SKU's on/off state is. A SKU can sit on several SK products
 * — typically the live one plus an archived discount copy — so the ACTIVE one
 * wins, exactly as it does for stock.
 */
function statusTruthOf(source: { listings: Map<string, Listing> }) {
  const truth = new Map<string, string>();
  for (const listing of source.listings.values()) {
    if (!MIRRORED.has(listing.status)) continue;
    for (const sku of listing.skus) {
      if (truth.get(sku) === undefined || listing.status === 'ACTIVE') truth.set(sku, listing.status);
    }
  }
  return truth;
}

type StatusChange = { id: string; handle: string; sku: string; from: string; to: string };

/** Products in one store whose state disagrees with SK and may be flipped. */
function statusChanges(listings: Map<string, Listing>, truth: Map<string, string>) {
  const changes: StatusChange[] = [];
  let conflicts = 0;

  for (const listing of listings.values()) {
    if (!MIRRORED.has(listing.status)) continue;
    const wanted = new Set([...listing.skus].map((sku) => truth.get(sku)).filter(Boolean));
    // Either SK knows nothing about this product, or its variants carry SKUs
    // that SK switches differently — flipping a guessed one would be worse than
    // leaving it alone, so it is only counted.
    if (wanted.size > 1) { conflicts++; continue; }
    if (wanted.size !== 1) continue;
    const [want] = wanted as Set<string>;
    if (want === listing.status) continue;
    changes.push({
      id: listing.id,
      handle: listing.handle,
      sku: [...listing.skus].sort()[0],
      from: listing.status,
      to: want,
    });
  }

  return { changes, conflicts };
}

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
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
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

    const statusTruth = statusTruthOf(source);

    const report: Record<string, unknown> = {};
    const logRows: unknown[] = [];
    let totalWritten = 0;
    let totalStatusWritten = 0;

    for (const store of stores) {
      const target = await readStore(store);
      const changes = target.rows.filter((r) => truth.has(r.sku) && truth.get(r.sku) !== r.available);
      const untrackedOnSk = target.untracked.filter((r) => truth.has(r.sku)).length;
      const status = statusChanges(target.listings, statusTruth);

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

      // Status goes product by product; there is no bulk equivalent of
      // inventorySetQuantities, but only the products that actually differ are
      // touched, which in a steady state is none.
      let statusWritten = 0;
      if (!dryRun) {
        for (const change of status.changes) {
          const res = await gql(store, target.token, UPDATE_STATUS, {
            input: { id: change.id, status: change.to },
          });
          const errs = res.productUpdate.userErrors;
          if (errs.length) {
            throw new Error(`[${store}] status update failed for ${change.handle}: ${JSON.stringify(errs).slice(0, 300)}`);
          }
          statusWritten++;
          logRows.push({
            direction: 'push',
            store,
            sku: change.sku,
            field: 'status',
            old_value: change.from,
            new_value: change.to,
            actor: 'inventory-mirror',
          });
        }
      }

      totalWritten += written;
      totalStatusWritten += statusWritten;
      report[store] = {
        tracked: target.rows.length,
        changed: changes.length,
        written,
        untrackedButOnSk: untrackedOnSk,
        statusChanged: status.changes.length,
        statusWritten,
        statusConflicts: status.conflicts,
      };
    }

    await logChanges(logRows);

    return Response.json({
      ok: true,
      dryRun,
      source: { skus: truth.size, variants: source.rows.length, statusSkus: statusTruth.size },
      stores: report,
      written: totalWritten,
      statusWritten: totalStatusWritten,
    }, { headers });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500, headers });
  }
});
