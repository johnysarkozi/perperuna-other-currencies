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

