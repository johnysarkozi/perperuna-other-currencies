#!/usr/bin/env node
/**
 * Fills in the localized gallery metafields for products that have none, by
 * learning the mapping from the products that do.
 *
 *   node scripts/gallery-localize.mjs                  # dry run
 *   node scripts/gallery-localize.mjs --apply
 *   node scripts/gallery-localize.mjs --locale=bg --handle=10-sprchovych-kociek-2x-kazda-vona
 *
 * The theme picks a gallery from custom.<locale>_images — a list of file
 * references in the same order as product.media. Where a product's gallery is
 * built entirely from artwork that already appears on other products, the
 * translated counterpart of every position is already known: some other product
 * shows the same Slovak file at some position, and its own localized list says
 * which file stands in for it.
 *
 * So: index every (Slovak file -> localized file) pair across the catalogue,
 * then walk the new product's media and look each position up.
 *
 * A position with no known counterpart falls back to the Slovak file, which is
 * how the hand-built galleries already treat artwork that carries no text.
 */

import { graphql, paginate } from '../lib/shopify.mjs';

const STORE = 'sk';
const LOCALES = ['bg', 'de'];

const PRODUCTS = `query P($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status
      media(first: 40) { nodes {
        mediaContentType
        ... on MediaImage { id image { url } }
        ... on Video { id preview { image { url } } }
      } }
      metafields(first: 20, namespace: "custom") { nodes { key value } }
    }
  }
}`;

const SET = `mutation M($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
}`;

/** Shopify appends _<uuid> when the same artwork is uploaded again. */
const baseName = (url) => url.split('/').pop().split('?')[0]
  .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.)/, '');

/**
 * Filenames are not identity. Generic names — 2.png, 6.png, 7.png — sit on
 * completely different artwork across product families, and the same artwork
 * gets a fresh name every time it is re-uploaded. So positions are matched on
 * what the image actually looks like: the CDN renders a given source file to
 * identical bytes at a fixed width, which makes a hash of that render an exact
 * identity check.
 */
const RENDER_WIDTH = 200;
const hashes = new Map();

async function contentHash(url) {
  if (hashes.has(url)) return hashes.get(url);
  const sized = `${url}${url.includes('?') ? '&' : '?'}width=${RENDER_WIDTH}`;
  let digest = null;
  for (let attempt = 0; attempt < 3 && !digest; attempt++) {
    try {
      const res = await fetch(sized);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
          .map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch { /* retried below */ }
    if (!digest) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  hashes.set(url, digest);
  return digest;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyLocale = args.find((a) => a.startsWith('--locale='))?.slice('--locale='.length);
const onlyHandle = args.find((a) => a.startsWith('--handle='))?.slice('--handle='.length);
const locales = LOCALES.filter((l) => !onlyLocale || l === onlyLocale);

console.log(apply ? '*** APPLY — writing to Shopify ***\n' : 'dry run — nothing will be written\n');

const products = (await paginate(STORE, PRODUCTS, (d) => d.products, { pageSize: 50 }))
  .filter((p) => p.status !== 'ARCHIVED');

const mediaOf = (p) => p.media.nodes.map((m) => {
  const url = m.image?.url ?? m.preview?.image?.url ?? null;
  return { id: m.id, url, video: m.mediaContentType === 'VIDEO', name: url ? baseName(url) : null };
});

const listOf = (p, locale) => {
  const raw = p.metafields.nodes.find((m) => m.key === `${locale}_images`)?.value;
  return raw ? JSON.parse(raw) : null;
};

// ---- learn the mapping ----------------------------------------------------

/** locale -> Slovak media id -> { localized id -> how many products agree } */
const byId = {};
/** locale -> hash of the Slovak artwork -> { localized id -> count } */
const byHash = {};
/** Localized ids we have seen, so a lookup can be reported as a real file. */
const seenNames = new Map();

const media = new Map(products.map((p) => [p.handle, mediaOf(p)]));
for (const list of media.values()) {
  for (const m of list) if (m.name) seenNames.set(m.id, m.name);
}

process.stderr.write('počítam odtlačky obrázkov');
for (const list of media.values()) {
  for (const m of list) {
    if (!m.url) continue;
    m.hash = await contentHash(m.url);
    process.stderr.write('.');
  }
}
process.stderr.write('\n\n');

for (const p of products) {
  const own = media.get(p.handle);
  for (const locale of LOCALES) {
    const list = listOf(p, locale);
    if (!list || list.length !== own.length) continue;
    byId[locale] ??= {};
    byHash[locale] ??= {};
    own.forEach((m, i) => {
      const target = list[i];
      if (!target) return;
      ((byId[locale][m.id] ??= {})[target] ??= []).push(p.handle);
      if (m.hash) ((byHash[locale][m.hash] ??= {})[target] ??= []).push(p.handle);
    });
  }
}

// Several candidates for one Slovak image usually means the same translated
// artwork was uploaded more than once as separate files, which is harmless.
// Hash the candidates too, so a real disagreement can be told from a duplicate.
const localizedUrl = new Map();
const candidates = new Set();
for (const locale of LOCALES) {
  for (const votes of Object.values(byHash[locale] ?? {})) {
    Object.keys(votes).forEach((id) => candidates.add(id));
  }
}
if (candidates.size) {
  // Every chosen counterpart gets hashed, not just the contested ones: a list
  // sometimes points back at another copy of the Slovak file, which is not a
  // translation at all and should read as "same as SK".
  const ids = [...candidates].filter((id) => id.includes('MediaImage'));
  for (let i = 0; i < ids.length; i += 50) {
    const d = await graphql(STORE, `query($ids: [ID!]!) {
      nodes(ids: $ids) { ... on MediaImage { id image { url } } }
    }`, { ids: ids.slice(i, i + 50) });
    for (const n of d.nodes) if (n?.image?.url) localizedUrl.set(n.id, n.image.url);
  }
  process.stderr.write(`overujem ${localizedUrl.size} sporných náprotivkov`);
  for (const url of localizedUrl.values()) { await contentHash(url); process.stderr.write('.'); }
  process.stderr.write('\n\n');
}

const sameArtwork = (ids) => {
  const seen = new Set(ids.map((id) => hashes.get(localizedUrl.get(id)) ?? id));
  return seen.size === 1;
};

const best = (votes) => {
  if (!votes) return null;
  const ranked = Object.entries(votes).sort((a, b) => b[1].length - a[1].length);
  const ids = ranked.map(([id]) => id);
  const duplicate = ids.length > 1 && sameArtwork(ids);
  return {
    id: ids[0],
    votes: ranked[0][1].length,
    from: [...new Set(ranked[0][1])],
    // A rival with as many votes as the winner is a real tie; anything else is
    // one product's list disagreeing with the rest, which the audit below names.
    contested: !duplicate && ids.length > 1 && ranked[1][1].length >= ranked[0][1].length,
    outvoted: !duplicate && ids.length > 1,
  };
};

/**
 * Where one product's localized list disagrees with what every other product
 * says the same artwork maps to, that product's list is the odd one out — most
 * likely built by hand against a gallery that has since been reordered.
 */
function auditExisting(locale) {
  const off = {};
  for (const p of products) {
    const list = listOf(p, locale);
    const own = media.get(p.handle);
    if (!list || !own || list.length !== own.length) continue;
    own.forEach((m, i) => {
      if (!m.hash) return;
      const hit = best(byHash[locale][m.hash]);
      if (!hit || !hit.outvoted) return;
      if (list[i] !== hit.id && !sameArtwork([list[i], hit.id])) {
        (off[p.handle] ??= []).push(i + 1);
      }
    });
  }
  return off;
}

for (const locale of LOCALES) {
  const learned = Object.keys(byHash[locale] ?? {}).length;
  const sources = products.filter((p) => listOf(p, locale)).length;
  console.log(`${locale}: naučené z ${sources} produktov, ${learned} rozlíšených grafík`);
}
console.log();

const suspect = Object.fromEntries(LOCALES.map((l) => [l, auditExisting(l)]));

// ---- fill the gaps --------------------------------------------------------

// A product only needs filling where the metafield is missing entirely; a list
// that is already there was placed by hand and is not ours to overwrite.
const targets = products.filter((p) => {
  if (onlyHandle && p.handle !== onlyHandle) return false;
  if (!p.media.nodes.length) return false;
  return locales.some((l) => !listOf(p, l));
});

let writes = 0;

for (const p of targets) {
  const own = media.get(p.handle);
  console.log(`=== ${p.handle}  [${p.status}]  ${own.length} pozícií`);

  for (const locale of locales) {
    if (listOf(p, locale)) { console.log(`    ${locale}: už existuje — nechávam`); continue; }

    const rows = own.map((m, i) => {
      // Same file on both products is certain; same artwork re-uploaded is
      // matched on the render hash, which is just as exact.
      let hit = best(byId[locale]?.[m.id]) ?? best(byHash[locale]?.[m.hash]);
      // A single vote coming only from a product whose own list is out of step
      // is worse than no answer: better a Slovak image than the wrong one.
      const shaky = hit && hit.votes <= 1 && hit.from.every((h) => suspect[locale][h]);
      if (shaky) hit = null;
      const matchedBy = hit ? (byId[locale]?.[m.id] ? 'ten istý súbor' : 'zhodná grafika') : null;
      // Falling back to the Slovak file is what the hand-built lists do for
      // artwork with no text on it.
      let target = hit?.id ?? m.id;
      // Pointing at another copy of the same Slovak artwork is not a translation.
      if (target !== m.id && m.hash && hashes.get(localizedUrl.get(target)) === m.hash) target = m.id;
      return {
        pos: String(i + 1).padStart(2, '0'),
        skName: m.name ?? 'video',
        target,
        translated: target !== m.id,
        matchedBy,
        contested: hit?.contested ?? false,
        votes: hit?.votes ?? 0,
        from: hit?.from ?? [],
        shaky,
      };
    });

    const translated = rows.filter((r) => r.translated).length;
    const unknown = rows.filter((r) => !r.matchedBy).length;
    console.log(`    ${locale}: ${translated} preložených, ${rows.length - translated} zo SK` +
      (unknown ? `  (${unknown} bez známeho náprotivku)` : ''));

    for (const r of rows) {
      const mark = r.translated ? '→' : '=';
      const note = r.translated
        ? `${seenNames.get(r.target) ?? r.target}  [${r.matchedBy}, ${r.votes}×${r.votes <= 1 ? ` — iba ${r.from[0]}` : ''}${r.contested ? ', NEJEDNOZNAČNÉ' : ''}]`
        : (r.shaky ? 'zo SK — jediný zdroj je nespoľahlivý' : r.matchedBy ? 'rovnaké ako SK' : 'zo SK — inde sa nevyskytuje');
      console.log(`        ${r.pos} ${mark} ${r.skName.padEnd(42).slice(0, 42)} ${note}`);
    }

    if (!apply) continue;
    const res = await graphql(STORE, SET, {
      metafields: [{
        ownerId: p.id,
        namespace: 'custom',
        key: `${locale}_images`,
        type: 'list.file_reference',
        value: JSON.stringify(rows.map((r) => r.target)),
      }],
    });
    const errs = res.metafieldsSet.userErrors;
    if (errs.length) console.log(`        ✗ ${JSON.stringify(errs)}`);
    else { writes++; console.log('        ✓ zapísané'); }
  }
  console.log();
}

for (const locale of locales) {
  const entries = Object.entries(suspect[locale]);
  if (!entries.length) continue;
  console.log(`! ${locale}: existujúce zoznamy, ktoré nesúhlasia so zvyškom katalógu —`);
  for (const [handle, positions] of entries) {
    console.log(`    ${handle}: pozície ${positions.join(', ')}`);
  }
  console.log();
}

console.log(apply
  ? `Done. ${writes} zoznam(ov) zapísaných.`
  : `Dry run complete. ${targets.length} produkt(ov) na doplnenie. Re-run with --apply.`);
