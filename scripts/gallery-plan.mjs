#!/usr/bin/env node
/**
 * Zostaví plán jazykovej galérie: pozícia produktu → fram vo Figme.
 *
 *   node scripts/gallery-plan.mjs SI              # → plan/sl-figma.json
 *   node scripts/gallery-plan.mjs IT --validate   # neprepíše plán, len porovná
 *
 * Beží v pracovnom priečinku pripravenom gallery-fetch.mjs, nad výstupom
 * gallery-hash.py. Rozhoduje v tomto poradí:
 *
 *   1. bez textu alebo video            → ponechá sa slovenské médium
 *   2. blízko sekcie Doplnujuce         → univerzálna fotka, ponechá sa
 *   3. grafika "Premeň sprchovú rutinu" → čaká na preklad, vynechá sa
 *   4. slovenská strana rozhodne        → fram v cieľovom jazyku
 *   5. nemecká strana rozhodne          → fram v cieľovom jazyku
 *   6. to isté médium už preložené inde → prevezme sa hotový súbor
 *   7. inak                             → vynechá sa a vypíše
 *
 * Fram sa hľadá geometriou: každá jazyková sekcia je kópia slovenskej, takže
 * framy sedia na rovnakých relatívnych súradniciach.
 */

import fs from 'node:fs';
const M = JSON.parse(fs.readFileSync('gallery-match.json','utf8'));
const frames = JSON.parse(fs.readFileSync('frames.json','utf8'));
const gkey = f => `${f.kind}|${f.gx},${f.gy}`;
const LANG = process.argv[2];
const VALIDATE = process.argv.includes('--validate');
const LOC = { SI:'sl', EN:'en', FR:'fr', IT:'it', ES:'es', HR:'hr', RO:'ro', HU:'hu' }[LANG];
const target = new Map(frames.filter(f => f.lang === LANG).map(f => [gkey(f), f]));

// Nemecká sekcia má jeden fram posunutý oproti slovenskej, takže nemeckú
// geometriu treba previesť na slovenskú, až potom hľadať v cieľovom jazyku.
const skFrames = frames.filter(f => f.lang === 'SK');
const deToSk = new Map();
for (const d of frames.filter(f => f.lang === 'DE')) {
  let best = null, bestD = Infinity;
  for (const s of skFrames) {
    if (s.kind !== d.kind) continue;
    const dist = Math.abs(s.gx - d.gx) + Math.abs(s.gy - d.gy);
    if (dist < bestD) { bestD = dist; best = s; }
  }
  if (best && bestD <= 400) deToSk.set(gkey(d), gkey(best));
}

const prods = JSON.parse(fs.readFileSync('sk-products.json','utf8')).filter(p => p.de);
const done = (LOC === 'sl' && !VALIDATE) ? 'sl' : null;
const reuse = new Map();
if (LOC === 'sl') for (const p of prods) if (p.sl) p.media.forEach((m,i) => { if (p.sl[i] !== m.id) reuse.set(m.id, p.sl[i]); });

/** Kandidát z jednej strany → fram v cieľovom jazyku, alebo null. */
function resolve(s, groups, bridge) {
  if (!s) return null;
  let g = (s.margin >= 18 || s.twins) ? s.top[0].g : null;
  if (!g) g = s.top.find(c => c.product && groups.has(c.product) && c.dist <= 60)?.g ?? null;
  if (!g) return null;
  if (bridge) g = deToSk.get(g) ?? null;
  return g ? target.get(g) ?? null : null;
}

const products = [], waiting = [], unresolved = [], reused = [], viaDe = [], genericReview = [];
for (const p of prods) {
  if (done && p[done]) continue;
  const groups = new Set();
  p.media.forEach((m,i) => { const h = M[`${p.handle}#${i+1}`]; const s = h?.sk;
    if (s && s.margin >= 18 && s.top[0].product) groups.add(s.top[0].product); });

  const positions = {}, skip = [];
  let keep = 0;
  p.media.forEach((m, i) => {
    const pos = i + 1, h = M[`${p.handle}#${pos}`];
    if (!h || !h.hasText || h.type !== 'IMAGE') { keep++; return; }
    if (h.dopDist <= 12) { keep++; return; }                       // univerzálna fotka
    const already = reuse.get(m.id);
    if (h.oprDist <= 14 && !already) { skip.push(pos); waiting.push(`${p.handle}#${pos}`); return; }

    // slovenská strana určuje, čo stránka ukazuje; nemecká pomôže len tam,
    // kde slovenské médium vo Figme dobrý náprotivok nemá (starší export)
    let t = resolve(h.sk, groups, false), src = 'sk';
    if (!t) { t = resolve(h.de, groups, true); src = 'de'; if (t) viaDe.push(`${p.handle}#${pos}`); }
    // Prepracovaná recenzia je len v sk/de/pl/bg. Špeciálnu netreba — stačí
    // bežná recenzia toho istého druhu (kocky ku kockám, čaje k čajom).
    if (!t && /recenzie/i.test(h.de?.top[0]?.name ?? '')) {
      const kind = h.de.top[0].name.includes('/CAJE/') ? 'CAJ' : 'KOCKY';
      t = [...target.values()].find((f) => f.kind === kind && /spolocne\/recenzie$/i.test(f.name)) ?? null;
      if (t) { src = 'bežná recenzia'; genericReview.push(`${p.handle}#${pos}`); }
    }
    if (t) positions[pos] = { figmaNode: t.id, figmaName: t.name, from: src };
    else if (already) { positions[pos] = { fileId: already, from: 'existujúci preklad' }; reused.push(`${p.handle}#${pos}`); }
    else { skip.push(pos); unresolved.push(`${p.handle}#${pos} (sk d=${h.sk?.dist} m=${h.sk?.margin}, de → ${h.de?.top[0].name ?? '—'})`); }
  });
  products.push({ handle: p.handle, positions, skip, keep });
}

fs.writeFileSync(VALIDATE ? `validate-${LOC}.json` : `/workspace/perperuna-other-currencies/plan/${LOC}-figma.json`,
  JSON.stringify({ locale: LOC, figmaFile: 'DY4Bgvk3iz0j0hiOQPYK8f', products }, null, 1));
console.log(`${LOC}: preložiť ${products.reduce((a,p)=>a+Object.keys(p.positions).length,0)}, vynechať ${products.reduce((a,p)=>a+p.skip.length,0)}, slovenské ${products.reduce((a,p)=>a+p.keep,0)}`);
if (viaDe.length) console.log(`cez nemeckú predlohu: ${viaDe.join(', ')}`);
if (genericReview.length) console.log(`bežná recenzia namiesto prepracovanej: ${genericReview.join(', ')}`);
if (reused.length) console.log(`prevzaté: ${reused.join(', ')}`);
if (waiting.length) console.log(`čaká na grafiku: ${waiting.join(', ')}`);
if (unresolved.length) { console.log(`nerozhodnuté (${unresolved.length}):`); for (const u of unresolved) console.log('  ' + u); }
