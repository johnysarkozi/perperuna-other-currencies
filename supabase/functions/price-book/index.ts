/**
 * price-book — saves and deletes named price books ("cenníky").
 *
 * A price book is a snapshot of what every listing cost at one moment. It is
 * how a season gets a name: save "bežné ceny" before a campaign, save
 * "vianočná akcia" during it, and either one can be put back on later without
 * anybody retyping a single figure.
 *
 *   { "action": "save",   "name": "Bežné ceny", "note": "pred BF", "password": "…" }
 *   { "action": "delete", "id": 3, "password": "…" }
 *
 * Only these two writes live here. Putting a book back on is *not* done from
 * this function: the dashboard diffs the book against the current catalog,
 * shows what would change and writes it through price-set, so a restore goes
 * through exactly the same checks (variant SKU verified, compare-at never
 * below price, every market planned before the first write) as a hand edit.
 *
 * The figures come from catalog_listings rather than from the browser: a
 * snapshot has to be whole, and a filter left on in the page must not be able
 * to quietly truncate it. price-set patches that table on every write, so the
 * catalog copy is current even between syncs.
 *
 * Gated by the same password as the other write functions — a book is what a
 * restore trusts, so a wrong or partial one is a pricing incident later.
 */

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

type Listing = {
  sku: string;
  store: string;
  shopify_variant_id: string;
  currency: string | null;
  price: string | null;
  compare_at_price: string | null;
};

Deno.serve(async (req) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const body = await req.json();
    const action = String(body.action ?? '');
    const password = String(body.password ?? '');

    const rows = await rest('catalog_settings?key=eq.edit_password_sha256&select=value');
    const expected = rows?.[0]?.value;
    if (!expected) throw new Error('edit password is not configured');
    if (await sha256Hex(password) !== expected) {
      return Response.json({ ok: false, error: 'Nesprávne heslo' }, { status: 403, headers });
    }

    if (action === 'delete') {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error('id is required');
      // Items go with it: the cascade is declared on the foreign key.
      await rest(`catalog_price_books?id=eq.${id}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
      return Response.json({ ok: true, deleted: id }, { headers });
    }

    if (action !== 'save') throw new Error(`unknown action ${action || '—'}`);

    const name = String(body.name ?? '').trim();
    const note = String(body.note ?? '').trim();
    if (!name) throw new Error('name is required');
    if (name.length > 80) throw new Error('name is too long');

    const listings: Listing[] = await rest(
      'catalog_listings?select=sku,store,shopify_variant_id,currency,price,compare_at_price'
      + '&price=not.is.null&order=sku',
    );
    if (!listings?.length) {
      // An empty catalog read would otherwise save a book that restores nothing
      // and looks, from the list, exactly like a good one.
      throw new Error('katalóg je prázdny — cenník by nemal čo obsahovať');
    }

    const created = await rest('catalog_price_books', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name, note: note || null }),
    }).catch((err) => {
      // Names are unique regardless of case: two books called "Bežné ceny" and
      // "bežné ceny" would be indistinguishable in the list, and a restore has
      // to be unambiguous.
      if (String(err).includes('23505')) {
        throw new Error(`cenník „${name}“ už existuje — daj mu iný názov`);
      }
      throw err;
    });
    const book = created?.[0];
    if (!book?.id) throw new Error('book was not created');

    try {
      const items = listings.map((l) => ({
        book_id: book.id,
        sku: l.sku,
        store: l.store,
        shopify_variant_id: l.shopify_variant_id,
        currency: l.currency,
        price: l.price,
        compare_at_price: l.compare_at_price,
      }));
      for (let i = 0; i < items.length; i += 200) {
        await rest('catalog_price_book_items', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(items.slice(i, i + 200)),
        });
      }
      return Response.json({ ok: true, id: book.id, name: book.name, items: items.length }, { headers });
    } catch (err) {
      // A book without its figures is worse than no book, so a half-written one
      // is removed rather than left in the list.
      await rest(`catalog_price_books?id=eq.${book.id}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      }).catch(() => {});
      throw err;
    }
  } catch (err) {
    // The message lands in a toast in the dashboard, so the bare sentence is
    // what a person should read — not "Error:" in front of it.
    const error = String(err instanceof Error ? err.message : err);
    return Response.json({ ok: false, error }, { status: 500, headers });
  }
});
