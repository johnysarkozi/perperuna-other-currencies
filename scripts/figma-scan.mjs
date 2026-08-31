#!/usr/bin/env node
/**
 * Read-only pohľad do Figma súboru — vypíše, čo v danom uzle je, aby sa dalo
 * rozhodnúť, ktoré framey patria na ktorú pozíciu v galérii.
 *
 *   node scripts/figma-scan.mjs "<figma url>"            # strom, hĺbka 3
 *   node scripts/figma-scan.mjs "<figma url>" --depth=5
 *   node scripts/figma-scan.mjs "<figma url>" --json=out.json
 *
 * Token sa berie výhradne z FIGMA_TOKEN (personal access token, scope
 * file_read). Nikdy nepatrí do kódu ani do commitu.
 *
 * Nič nezapisuje — ani do Figmy, ani do Shopify.
 */

const TOKEN = process.env.FIGMA_TOKEN;
if (!TOKEN) {
  console.error('Chýba FIGMA_TOKEN (personal access token so scope file_read).');
  process.exit(1);
}

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const depth = Number(args.find((a) => a.startsWith('--depth='))?.slice(8) ?? 3);
const jsonOut = args.find((a) => a.startsWith('--json='))?.slice(7);

if (!url) {
  console.error('Usage: figma-scan.mjs "<figma url>" [--depth=3] [--json=out.json]');
  process.exit(1);
}

/** Figma dáva v URL node-id s pomlčkou, API ho chce s dvojbodkou. */
export function parseFigmaUrl(u) {
  const key = u.match(/\/(?:file|design)\/([A-Za-z0-9]+)/)?.[1];
  const node = new URL(u).searchParams.get('node-id')?.replace('-', ':');
  if (!key) throw new Error(`Z URL sa nedá vytiahnuť file key: ${u}`);
  return { key, node };
}

export async function figma(path) {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { 'X-Figma-Token': TOKEN },
  });
  if (!res.ok) throw new Error(`Figma ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const { key, node } = parseFigmaUrl(url);
console.log(`súbor ${key}${node ? `, uzol ${node}` : ''}, hĺbka ${depth}\n`);

const data = node
  ? await figma(`/files/${key}/nodes?ids=${encodeURIComponent(node)}&depth=${depth}`)
  : await figma(`/files/${key}?depth=${depth}`);

const roots = node
  ? Object.values(data.nodes).map((n) => n.document)
  : [data.document];

function box(n) {
  const b = n.absoluteBoundingBox;
  return b ? ` ${Math.round(b.width)}×${Math.round(b.height)}` : '';
}

let count = 0;
function walk(n, indent = '') {
  count++;
  console.log(`${indent}${n.name}   [${n.type} ${n.id}]${box(n)}`);
  for (const c of n.children ?? []) walk(c, `${indent}  `);
}

for (const r of roots) walk(r);
console.log(`\n${count} uzlov`);

if (jsonOut) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(jsonOut, JSON.stringify(data, null, 1));
  console.log(`→ ${jsonOut}`);
}
