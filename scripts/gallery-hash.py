#!/usr/bin/env python3
"""
Perceptuálne hashovanie: spáruje médium produktu s framom vo Figme.

Jediný súbor v repe, ktorý nie je Node — dHash potrebuje dekodér obrázkov
a médiá sú jpg/png/webp, čo sa v čistom Node bez závislostí spraviť nedá.
Beží v pracovnom priečinku, ktorý pripraví gallery-fetch.mjs.

    python3 scripts/gallery-hash.py        # → gallery-match.json

Pre každú pozíciu galérie hodnotí obe strany: slovenské médium proti
slovenským framom a nemecký súbor proti nemeckým. Slovenská strana hovorí,
čo stránka ukazuje; nemecká pomôže tam, kde slovenské médium vo Figme dobrý
náprotivok nemá (staršie exporty).
"""

import json, os
from PIL import Image

def dhash(path, s=16):
    try: im = Image.open(path).convert('L').resize((s+1, s), Image.LANCZOS)
    except Exception: return None
    px = im.load(); b = 0
    for y in range(s):
        for x in range(s): b = (b << 1) | (1 if px[x, y] < px[x+1, y] else 0)
    return b
def ham(a, b): return bin(a ^ b).count('1')

frames = json.load(open('frames.json'))
byid = {f['id']: f for f in frames}
gkey = lambda f: f"{f['kind']}|{f['gx']},{f['gy']}"

def pool(dirname, sel):
    out = {}
    for f in sel:
        h = dhash(f"{dirname}/{f['id'].replace(':','_')}.png")
        if h is not None: out[f['id']] = h
    return out

skF = pool('thumbs/figma',    [f for f in frames if f['lang'] == 'SK'])
deF = pool('thumbs/figma-de', [f for f in frames if f['lang'] == 'DE'])
dop = [h for h in pool('thumbs/figma-dop', [f for f in frames if f['section'] == 'Doplnujuce']).values()]
opr = [h for h in (dhash(f'thumbs/figma-opr/{fn}') for fn in os.listdir('thumbs/figma-opr')) if h]

def side(hh, P):
    """Zoradení kandidáti + či sú tí najbližší medzi sebou rozoznateľní."""
    if hh is None: return None
    r = sorted(({'id': fid, 'g': gkey(byid[fid]), 'dist': ham(hh, h),
                 'product': byid[fid]['product'], 'name': byid[fid]['name']}
                for fid, h in P.items()), key=lambda c: c['dist'])
    near = [c for c in r if c['dist'] <= r[0]['dist'] + 18]
    twins = all(ham(P[a['id']], P[b['id']]) <= 10 for a in near for b in near)
    return {'dist': r[0]['dist'], 'margin': (r[1]['dist'] - r[0]['dist']) if len(r) > 1 else 99,
            'twins': twins, 'top': r[:6]}

prods = [p for p in json.load(open('sk-products.json')) if p['de']]
out = {}
for p in prods:
    for i, m in enumerate(p['media']):
        mh = dhash(f"thumbs/shopify/{m['id'].split('/')[-1]}.img")
        deid = p['de'][i] if i < len(p['de']) else None
        dh = dhash(f"thumbs/defiles/{deid.split('/')[-1]}.img") if deid else None
        if mh is None: continue
        out[f"{p['handle']}#{i+1}"] = {
            'sk': side(mh, skF), 'de': side(dh, deF),
            'dopDist': min((ham(mh, h) for h in dop), default=999),
            'oprDist': min((ham(mh, h) for h in opr), default=999),
            'hasText': deid is not None and deid != m['id'],
            'type': m['type'], 'mediaId': m['id'],
        }
json.dump(out, open('gallery-match.json','w'), indent=1)
print('pozícií', len(out))
