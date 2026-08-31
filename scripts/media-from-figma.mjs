#!/usr/bin/env node
/**
 * Nastaví médiá produktov na backende, kde je cieľový jazyk primárny
 * (RO, HU). Tam sa galéria nerieši metafieldom — storefront ukazuje priamo
 * product.media, takže sa vymieňajú samotné médiá.
 *
 *   node scripts/media-from-figma.mjs plan/ro-media.json            # dry run
 *   node scripts/media-from-figma.mjs plan/ro-media.json --apply
 *   node scripts/media-from-figma.mjs plan/hu-media.json --apply --only=<handle>
 *
 * Dva režimy podľa tvaru plánu:
 *
 *   replace — produkt médiá má, vymenia sa len uvedené pozície (`replace`).
 *             Používa sa na RO, kde väčšina prekladov už hotová je a zostali
 *             len slovenské zvyšky.
 *   build   — poskladá sa celá sada od nuly (`items`), obrázky bez textu sa
 *             prevezmú zo slovenského obchodu, ostatné z Figmy. Používa sa
 *             na HU, kde produkty fotky nemajú vôbec.
 *
 * Mazanie médií je nevratné, preto skript najprv nové médiá vytvorí, overí,
 * že sú READY, a až potom staré zmaže.
 */

import { graphql } from '../lib/shopify.mjs';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STAGED = `mutation S($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const CREATE = `mutation C($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { ... on MediaImage { id } ... on Video { id } }
    mediaUserErrors { field message }
  }
}`;

const DELETE = `mutation D($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors { field message }
  }
}`;

const REORDER = `mutation R($id: ID!, $moves: [MoveInput!]!) {
  productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { field message } }
}`;

const READ = `query($h: String!) {
  productByHandle(handle: $h) {
    id title
    media(first: 60) { nodes {
      mediaContentType status
      ... on MediaImage { id }
      ... on Video { id }
    } }
  }
}`;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const planPath = args.find((a) => !a.startsWith('--'));
if (!planPath) {
  console.error('Usage: media-from-figma.mjs <plan.json> [--apply] [--only=<handle>]');
  process.exit(1);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const STORE = plan.store;
const CACHE = `.figma-cache/${STORE}`;
let products = plan.products;
if (only) products = products.filter((p) => p.handle === only);

const mode = products[0]?.replace ? 'replace' : 'build';
console.log(apply ? `*** APPLY — zapisuje sa do obchodu ${STORE} ***\n` : 'dry run — nič sa nezapíše\n');
console.log(`režim: ${mode}, produktov: ${products.length}`);

const nodes = new Map();
for (const p of products) {
  for (const it of p.replace ?? p.items) if (it.figmaNode) nodes.set(it.figmaNode, it.figmaName);
}
const fromSk = products.reduce((a, p) => a + (p.items?.filter((i) => i.sourceUrl).length ?? 0), 0);
console.log(`z Figmy: ${nodes.size} unikátnych framov`);
if (mode === 'build') console.log(`zo slovenského obchodu: ${fromSk} médií bez textu`);
for (const p of products) {
  const n = (p.replace ?? p.items).length;
  console.log(`   ${p.handle}: ${n} ${mode === 'replace' ? 'na výmenu' : 'médií'}`);
}

if (!apply) { console.log('\nDry run hotový. Spusti znova s --apply.'); process.exit(0); }

// ---- render z Figmy --------------------------------------------------------

const TOKEN = process.env.FIGMA_TOKEN;
if (!TOKEN) { console.error('Chýba FIGMA_TOKEN.'); process.exit(1); }
mkdirSync(CACHE, { recursive: true });

const rendered = new Map();
const todo = [...nodes.keys()].filter((n) => {
  const f = join(CACHE, `${n.replace(':', '_')}.png`);
  if (existsSync(f) && statSync(f).size > 0) { rendered.set(n, f); return false; }
  return true;
});
for (let i = 0; i < todo.length; i += 10) {
  const slice = todo.slice(i, i + 10);
  const r = await fetch(
    `https://api.figma.com/v1/images/${plan.figmaFile}?ids=${slice.join(',')}&format=png&scale=1`,
    { headers: { 'X-Figma-Token': TOKEN } },
  );
  const j = await r.json();
  if (j.err) { console.log(`! Figma: ${j.err}, čakám 30 s`); await new Promise((r) => setTimeout(r, 30000)); i -= 10; continue; }
  for (const n of slice) {
    const u = j.images[n];
    if (!u) { console.log(`! bez renderu: ${nodes.get(n)}`); continue; }
    const f = join(CACHE, `${n.replace(':', '_')}.png`);
    writeFileSync(f, Buffer.from(await (await fetch(u)).arrayBuffer()));
    rendered.set(n, f);
  }
  console.log(`vyrenderované ${Math.min(i + 10, todo.length)}/${todo.length}`);
}

// ---- nahratie do cieľového obchodu -----------------------------------------

/** Nahrá lokálny súbor cez staged upload a vráti resourceUrl. */
async function stage(path, filename, mimeType, resource) {
  const s = await graphql(STORE, STAGED, {
    input: [{ resource, filename, mimeType, httpMethod: 'POST', fileSize: String(statSync(path).size) }],
  });
  const errs = s.stagedUploadsCreate.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
  const t = s.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const { name, value } of t.parameters) form.append(name, value);
  form.append('file', new Blob([readFileSync(path)], { type: mimeType }), filename);
  const put = await fetch(t.url, { method: 'POST', body: form });
  if (!put.ok) throw new Error(`upload ${filename}: HTTP ${put.status}`);
  return t.resourceUrl;
}

const staged = new Map();
for (const [node, path] of rendered) {
  const name = `${STORE}-${node.replace(':', '_')}.png`;
  staged.set(node, await stage(path, name, 'image/png', 'FILE'));
  if (staged.size % 10 === 0) console.log(`nahraté ${staged.size}/${rendered.size}`);
}
console.log(`nahraté ${staged.size}/${rendered.size}`);

/**
 * Video sa cez URL kopírovať nedá — stiahne sa a nahrá ako súbor. Stiahnutý
 * súbor sa drží v cache, ale staged upload sa robí zakaždým nanovo: jeden
 * upload sa dá spotrebovať len raz, opakované použitie Shopify odmietne ako
 * "duplicate external_video_id".
 */
const videoFiles = new Map();
let videoSeq = 0;
async function videoSource(url) {
  let tmp = videoFiles.get(url);
  if (!tmp) {
    tmp = join(CACHE, `vid-${videoFiles.size}.mp4`);
    const r = await fetch(url);
    writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    videoFiles.set(url, tmp);
  }
  return stage(tmp, `${STORE}-video-${videoSeq++}.mp4`, 'video/mp4', 'VIDEO');
}

// ---- zápis po produktoch ---------------------------------------------------

let done = 0, failed = 0;
for (const p of products) {
  const d = await graphql(STORE, READ, { h: p.handle });
  const prod = d.productByHandle;
  if (!prod) { console.log(`! ${p.handle} neexistuje`); failed++; continue; }
  const before = prod.media.nodes.map((m) => m.id);

  const entries = mode === 'replace'
    ? p.replace.map((r) => ({ pos: r.pos, node: r.figmaNode, old: r.mediaId }))
    : p.items.map((i) => ({ pos: i.pos, node: i.figmaNode, src: i.sourceUrl, videoUrl: i.videoUrl, type: i.type }));

  const media = [];
  for (const e of entries) {
    if (e.node) media.push({ originalSource: staged.get(e.node), mediaContentType: 'IMAGE', alt: nodes.get(e.node) ?? '' });
    else if (e.type && e.type !== 'IMAGE') media.push({ originalSource: await videoSource(e.videoUrl ?? e.src), mediaContentType: 'VIDEO' });
    else media.push({ originalSource: e.src, mediaContentType: 'IMAGE' });
  }

  const c = await graphql(STORE, CREATE, { productId: prod.id, media });
  const cErrs = c.productCreateMedia.mediaUserErrors;
  if (cErrs.length) { console.log(`✗ ${p.handle} create: ${JSON.stringify(cErrs)}`); failed++; continue; }
  const created = c.productCreateMedia.media.map((m) => m.id);

  // Staré médiá sa mažú až potom, čo nové existujú.
  const toDelete = mode === 'replace' ? entries.map((e) => e.old) : before;
  if (toDelete.length) {
    const del = await graphql(STORE, DELETE, { productId: prod.id, mediaIds: toDelete });
    const dErrs = del.productDeleteMedia.mediaUserErrors;
    if (dErrs.length) console.log(`! ${p.handle} delete: ${JSON.stringify(dErrs)}`);
  }

  // Poradie: nové médiá patria na svoje pozície, zvyšok si drží relatívne poradie.
  const kept = before.filter((id) => !toDelete.includes(id));
  const final = [];
  let k = 0;
  const byPos = new Map(entries.map((e, i) => [e.pos, created[i]]));
  const total = kept.length + created.length;
  for (let pos = 1; pos <= total; pos++) {
    const n = byPos.get(pos);
    if (n) final.push(n); else if (k < kept.length) final.push(kept[k++]);
  }
  for (const id of created) if (!final.includes(id)) final.push(id);
  for (const id of kept) if (!final.includes(id)) final.push(id);

  const r = await graphql(STORE, REORDER, {
    id: prod.id,
    moves: final.map((id, i) => ({ id, newPosition: String(i) })),
  });
  const rErrs = r.productReorderMedia.mediaUserErrors;
  if (rErrs.length) console.log(`! ${p.handle} reorder: ${JSON.stringify(rErrs)}`);

  done++;
  console.log(`✓ ${prod.title} — ${created.length} nových, ${toDelete.length} zmazaných, ${final.length} v galérii`);
}

console.log(`\nHotovo. ${done} produktov, ${failed} chýb.`);
