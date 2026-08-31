#!/usr/bin/env node
/**
 * Naplní jazykovú galériu (custom.<locale>_images) obrázkami z Figmy.
 *
 *   node scripts/gallery-from-figma.mjs plan/sl-figma.json                 # dry run
 *   node scripts/gallery-from-figma.mjs plan/sl-figma.json --apply
 *   node scripts/gallery-from-figma.mjs plan/sl-figma.json --apply --source=./export
 *
 * Zdroj obrázkov:
 *   --source=figma   (default) render cez Figma REST API, potrebuje FIGMA_TOKEN.
 *   --source=<dir>   lokálny export z Figmy. Figma pri exporte mení lomky
 *                    v názve framu na priečinky, takže strom sedí s figmaName
 *                    v pláne a netreba nič prečíslovávať.
 *
 * Pozícia, ktorá v pláne nemá záznam, sa rieši podľa `skip`:
 *   - v `skip`  → z galérie sa vynechá úplne (radšej menej fotiek než slovenská
 *                 fotka s cudzím textom),
 *   - inak      → ponechá sa slovenské médium (obrázok bez textu je jazykovo
 *                 neutrálny, prekladať ho netreba).
 */

import { graphql } from '../lib/shopify.mjs';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const STORE = 'sk';
const RENDER_SCALE = 1;

const STAGED = `mutation S($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const FILE_CREATE = `mutation F($files: [FileCreateInput!]!) {
  fileCreate(files: $files) { files { id fileStatus } userErrors { field message } }
}`;

const FILE_STATUS = `query S($ids: [ID!]!) {
  nodes(ids: $ids) { ... on MediaImage { id fileStatus } }
}`;

const SET = `mutation M($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
}`;

const DEFINITION = `mutation D($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id key }
    userErrors { field message code }
  }
}`;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const source = args.find((a) => a.startsWith('--source='))?.slice(9) ?? 'figma';
const planPath = args.find((a) => !a.startsWith('--'));

if (!planPath) {
  console.error('Usage: gallery-from-figma.mjs <plan.json> [--apply] [--source=figma|<dir>]');
  process.exit(1);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const { locale, figmaFile } = plan;
const CACHE = `.figma-cache/${locale}`;

console.log(apply ? '*** APPLY — zapisuje sa do Shopify ***\n' : 'dry run — nič sa nezapíše\n');

/** Jeden render na fram, aj keď ho používa viac produktov. */
const wanted = new Map();
for (const p of plan.products) {
  for (const slot of Object.values(p.positions)) {
    // slot.fileId = tá istá grafika už raz preložená inde; netreba ju renderovať
    if (slot.figmaNode) wanted.set(slot.figmaNode, slot.figmaName);
  }
}

const translated = plan.products.reduce((a, p) => a + Object.keys(p.positions).length, 0);
const skipped = plan.products.reduce((a, p) => a + p.skip.length, 0);
console.log(`jazyk: ${locale}`);
console.log(`produktov: ${plan.products.length}`);
console.log(`preložených pozícií: ${translated} (${wanted.size} unikátnych framov)`);
console.log(`vynechaných pozícií: ${skipped}`);
console.log(`zdroj: ${source}\n`);

for (const p of plan.products) {
  const n = Object.keys(p.positions).length;
  console.log(`   ${p.handle}: ${n} preložených, ${p.skip.length} vynechaných, ${p.keep} slovenských`);
}
console.log();

if (!apply) {
  console.log('Dry run hotový. Spusti znova s --apply.');
  process.exit(0);
}

// ---- získanie obrázkov -----------------------------------------------------

/** Vráti mapu figmaNode → cesta k PNG na disku. */
async function collect() {
  const paths = new Map();
  mkdirSync(CACHE, { recursive: true });

  if (source !== 'figma') {
    for (const [node, name] of wanted) {
      // "PG PERPERUNA/KOCKY/SI/UPLIFT/ 5" → PG PERPERUNA/KOCKY/SI/UPLIFT/5.png
      const rel = name.split('/').map((s) => s.trim()).join('/');
      const cand = [`${rel}.png`, `${rel}.jpg`, `${rel}.PNG`];
      const found = cand.map((c) => join(source, c)).find(existsSync);
      if (found) paths.set(node, found);
      else console.log(`! v exporte chýba: ${name}`);
    }
    return paths;
  }

  const TOKEN = process.env.FIGMA_TOKEN;
  if (!TOKEN) { console.error('Chýba FIGMA_TOKEN.'); process.exit(1); }

  const todo = [...wanted].filter(([node]) => {
    const f = join(CACHE, `${node.replace(':', '_')}.png`);
    if (existsSync(f) && statSync(f).size > 0) { paths.set(node, f); return false; }
    return true;
  });

  for (let i = 0; i < todo.length; i += 10) {
    const slice = todo.slice(i, i + 10);
    let j;
    // Figma render má prísny, pomaly sa obnovujúci limit — pri 429 sa čaká.
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await fetch(
        `https://api.figma.com/v1/images/${figmaFile}?ids=${slice.map(([n]) => n).join(',')}&format=png&scale=${RENDER_SCALE}`,
        { headers: { 'X-Figma-Token': TOKEN } },
      );
      j = await r.json();
      if (!j.err) break;
      const wait = Number(r.headers.get('retry-after') ?? 60);
      console.log(`! Figma limit (${j.err}), retry-after ${wait}s`);
      if (wait > 600) { console.error('Limit je príliš dlhý — použi --source=<dir> s exportom.'); process.exit(1); }
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    if (j.err) { console.error(`Figma: ${j.err}`); process.exit(1); }

    for (const [node, name] of slice) {
      const u = j.images[node];
      if (!u) { console.log(`! bez renderu: ${name}`); continue; }
      const f = join(CACHE, `${node.replace(':', '_')}.png`);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, Buffer.from(await (await fetch(u)).arrayBuffer()));
      paths.set(node, f);
    }
    console.log(`vyrenderované ${Math.min(i + 10, todo.length)}/${todo.length}`);
  }
  return paths;
}

const paths = await collect();
if (paths.size < wanted.size) {
  console.log(`\n! chýba ${wanted.size - paths.size} framov — tie pozície sa vynechajú`);
}

// ---- nahratie do Shopify Files ---------------------------------------------

const def = await graphql(STORE, DEFINITION, {
  definition: {
    name: `${locale.toUpperCase()} Images`,
    namespace: 'custom',
    key: `${locale}_images`,
    type: 'list.file_reference',
    ownerType: 'PRODUCT',
    description: `Galéria pre jazyk ${locale}, v rovnakom poradí ako médiá produktu.`,
  },
});
const defErrs = def.metafieldDefinitionCreate.userErrors;
if (defErrs.length && !defErrs.some((e) => e.code === 'TAKEN')) {
  console.log(`! definícia metafieldu: ${JSON.stringify(defErrs)}`);
}

const uploaded = new Map();
const entries = [...paths];
for (let i = 0; i < entries.length; i += 5) {
  const slice = entries.slice(i, i + 5);
  const names = slice.map(([node]) => `${locale}-${node.replace(':', '_')}.png`);

  const staged = await graphql(STORE, STAGED, {
    input: slice.map(([, path], k) => ({
      resource: 'FILE',
      filename: names[k],
      mimeType: 'image/png',
      httpMethod: 'POST',
      fileSize: String(statSync(path).size),
    })),
  });
  const sErrs = staged.stagedUploadsCreate.userErrors;
  if (sErrs.length) { console.log(`✗ staged: ${JSON.stringify(sErrs)}`); continue; }

  const targets = staged.stagedUploadsCreate.stagedTargets;
  for (const [k, target] of targets.entries()) {
    const form = new FormData();
    for (const { name, value } of target.parameters) form.append(name, value);
    form.append('file', new Blob([readFileSync(slice[k][1])], { type: 'image/png' }), names[k]);
    const put = await fetch(target.url, { method: 'POST', body: form });
    if (!put.ok) console.log(`✗ upload ${names[k]}: HTTP ${put.status}`);
  }

  const res = await graphql(STORE, FILE_CREATE, {
    files: targets.map((t, k) => ({
      originalSource: t.resourceUrl,
      contentType: 'IMAGE',
      filename: names[k],
      alt: wanted.get(slice[k][0]).replace(/^PG PERPERUNA\//, '').replace(/\//g, ' · '),
    })),
  });
  const errs = res.fileCreate.userErrors;
  if (errs.length) { console.log(`✗ fileCreate: ${JSON.stringify(errs)}`); continue; }
  res.fileCreate.files.forEach((f, k) => uploaded.set(slice[k][0], f.id));
  console.log(`nahraté ${Math.min(i + 5, entries.length)}/${entries.length}`);
}

// Shopify spracúva nahraté súbory asynchrónne; súbor použitý pred stavom READY
// sa na frontende zobrazí ako rozbitý obrázok.
process.stdout.write('čakám na spracovanie');
const ids = [...uploaded.values()];
for (let attempt = 0; attempt < 40; attempt++) {
  const pending = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await graphql(STORE, FILE_STATUS, { ids: ids.slice(i, i + 50) });
    for (const n of d.nodes) if (n && n.fileStatus !== 'READY') pending.push(n.id);
  }
  if (!pending.length) { console.log(' — hotovo\n'); break; }
  process.stdout.write(`.${pending.length}`);
  await new Promise((r) => setTimeout(r, 3000));
}

// ---- zápis galérií ---------------------------------------------------------

let writes = 0;
for (const p of plan.products) {
  const d = await graphql(STORE, `query($h: String!) {
    productByHandle(handle: $h) {
      id title
      media(first: 40) { nodes { ... on MediaImage { id } ... on Video { id } } }
    }
  }`, { h: p.handle });
  if (!d.productByHandle) { console.log(`! ${p.handle} neexistuje`); continue; }

  const skIds = d.productByHandle.media.nodes.map((m) => m.id);
  const skipSet = new Set(p.skip);
  const list = [];
  let n = 0, dropped = 0;
  skIds.forEach((id, i) => {
    const slot = p.positions[String(i + 1)];
    const fileId = slot ? (slot.fileId ?? uploaded.get(slot.figmaNode)) : null;
    if (fileId) { list.push(fileId); n++; }
    else if (slot || skipSet.has(i + 1)) dropped++;   // nesie text, preklad nemáme → vynechať
    else list.push(id);                                // bez textu → slovenské médium
  });

  const res = await graphql(STORE, SET, {
    metafields: [{
      ownerId: d.productByHandle.id,
      namespace: 'custom',
      key: `${locale}_images`,
      type: 'list.file_reference',
      value: JSON.stringify(list),
    }],
  });
  const errs = res.metafieldsSet.userErrors;
  if (errs.length) console.log(`✗ ${p.handle}: ${JSON.stringify(errs)}`);
  else { writes++; console.log(`✓ ${d.productByHandle.title} — ${n} preložených, ${dropped} vynechaných, ${list.length} v galérii`); }
}

console.log(`\nHotovo. ${uploaded.size} súborov, ${writes} galérií.`);
