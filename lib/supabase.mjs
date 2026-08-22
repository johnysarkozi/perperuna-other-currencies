/**
 * Minimal Supabase REST client — no dependency on @supabase/supabase-js,
 * consistent with this repo's "just fetch" convention.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
 * The service role key bypasses RLS — this is a server-side sync script,
 * never ship this key to a browser.
 */

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${path}`;
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Insert or update rows, matched on the given unique column(s). */
export function upsert(table, rows, { onConflict } = {}) {
  if (!rows.length) return Promise.resolve([]);
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  return request(`${table}${qs}`, {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
}

export function select(table, query = '') {
  return request(`${table}${query ? `?${query}` : ''}`);
}

export function insert(table, rows) {
  if (!rows.length) return Promise.resolve([]);
  return request(table, { method: 'POST', body: rows, headers: { Prefer: 'return=minimal' } });
}
