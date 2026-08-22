/**
 * Multi-backend Shopify Admin API client.
 *
 * Each backend (cz, ro, pl, hu, ...) is a separate Shopify store with its own
 * custom app. Credentials come from the environment following the convention
 * SHOPIFY_<KEY>_SHOP / _CLIENT_ID / _CLIENT_SECRET, and SHOPIFY_SHOPS lists the
 * enabled keys. Nothing is ever read from or written to disk.
 *
 * Tokens are minted on demand via the client_credentials grant and cached in
 * memory for the process lifetime (Shopify issues them with a 24h lifetime).
 */

export const API_VERSION = '2025-07';

/** Backend keys enabled in this environment, e.g. ['sk','cz','ro','pl','hu']. */
export const shopKeys = () =>
  (process.env.SHOPIFY_SHOPS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const envName = (key, suffix) => `SHOPIFY_${key.toUpperCase()}_${suffix}`;

function credentials(key) {
  const out = {};
  for (const suffix of ['SHOP', 'CLIENT_ID', 'CLIENT_SECRET']) {
    const name = envName(key, suffix);
    const value = process.env[name];
    if (!value) throw new Error(`missing ${name}`);
    out[suffix] = value;
  }
  return out;
}

const tokenCache = new Map();

/** Mint (or reuse) an Admin API access token for a backend. */
export async function accessToken(key) {
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const { SHOP, CLIENT_ID, CLIENT_SECRET } = credentials(key);
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
  if (!res.ok) throw new Error(`[${key}] token request failed: HTTP ${res.status} ${body.slice(0, 200)}`);

  const grant = JSON.parse(body);
  tokenCache.set(key, {
    token: grant.access_token,
    expiresAt: Date.now() + (grant.expires_in ?? 86_400) * 1000,
  });
  return grant.access_token;
}

/**
 * Run an Admin GraphQL operation against one backend.
 * Retries once on a 429 or 5xx, honouring Retry-After when present.
 */
export async function graphql(key, query, variables = {}, { retries = 1 } = {}) {
  const { SHOP } = credentials(key);
  const token = await accessToken(key);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.text();

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`[${key}] HTTP ${res.status}: ${body.slice(0, 300)}`);

    const json = JSON.parse(body);
    if (json.errors) throw new Error(`[${key}] GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
    return json.data;
  }
}

/**
 * Page through a connection until exhausted.
 * `select` receives the query data and returns the connection object.
 */
export async function paginate(key, query, select, { variables = {}, pageSize = 100, max = Infinity } = {}) {
  const nodes = [];
  let after = null;

  while (nodes.length < max) {
    const data = await graphql(key, query, { ...variables, first: Math.min(pageSize, max - nodes.length), after });
    const conn = select(data);
    nodes.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

/** Run `fn(key)` for every backend concurrently, keeping failures per backend. */
export async function forEachShop(fn, keys = shopKeys()) {
  const settled = await Promise.allSettled(keys.map((k) => fn(k)));
  return keys.map((key, i) => {
    const r = settled[i];
    return r.status === 'fulfilled'
      ? { key, ok: true, value: r.value }
      : { key, ok: false, error: r.reason?.message ?? String(r.reason) };
  });
}
