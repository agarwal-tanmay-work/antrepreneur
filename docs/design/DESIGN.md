# Antrepreneur design system

The site is one glass ant farm seen in cross-section. The live colony lives in it; everything else is the farm's material.

## World
- **Ground:** sand with fractal grain. Strata darken as you scroll: sand `#ebd29b` (hero, page) → deep sand `#dfc187` (colony) → clay `#c99a62` (jobs) → loam `#4a2e1b` (simulation) → bedrock `#24160c` (trust, footer). Each stratum meets the next on an irregular soil edge.
- **Frame:** molded toy-green plastic `#2e7d3b` (hi `#3d9a4c`, lo `#1f5a29`). A fixed frame around the viewport; the top rail holds the wordmark, section links and network.
- **Material roles:** loam = tunnels, chambers, ink (`#2a1a0e`, secondary `#5a4130`, tertiary `#7a5d45`). Seed gold `#f2c14e` (edge `#b5862a`) = food and wages. Starving `#a8481a`. Starved / fossil `#8c7a62`. Injection / danger `#9b2f1c`. Text on dark strata `#f2e3c4`, secondary `#cdb48d`.

## Type
- Display: Bricolage Grotesque (variable), 700–800, tracking -0.03 to -0.045em, line-height ~1.
- Text: Schibsted Grotesk (variable), 16px base, 1.55 line-height, measure ≤ 62ch.
- Data: JetBrains Mono, only for numbers, hashes and keys, always `tabular-nums`.
- All fonts self-hosted through @fontsource (no external font requests).

## Components
- **Buttons:** primary = frame-green plastic with an inner highlight and a soft green shadow; quiet = 1px loam outline. Radius 12px (10px small). Press: `scale(0.97)` in 140ms.
- **Chips:** pill outline; selected state fills with loam.
- **Ledger:** table rows with 1px loam lines; food is shown as seeds (8 max), price as a real history line.
- **Drawer:** right-side panel on sand, 380ms `cubic-bezier(0.32,0.72,0,1)`, Escape closes, scrim behind.
- **Verdict:** loam block with seed-gold checks; answers are outlined cards, green for the winner, rust for an injection.
- **Icons:** lucide-react, 1.5–2px stroke. The ant glyph is an authored SVG.

## Motion
- Easing: `--ease-out cubic-bezier(0.23,1,0.32,1)` for UI, `--ease-in-out cubic-bezier(0.77,0,0.175,1)` for travel, `--ease-drawer` for the drawer.
- One hero entrance on load (rise + blur, 70ms stagger). Nothing else enters on scroll.
- Signature: ants walk their tunnels when their on-chain state changes (answer a job → walk to the job chamber; job settles → walk home; the winner carries a seed). Idle ants amble slowly inside their chamber.
- Hover effects only under `(hover: hover) and (pointer: fine)`. Reduced motion: fades only, ants move instantly, legs still.

## Browser surfaces
Selection = seed gold on ink. Caret = frame green. Focus ring = 2px frame green, 3px offset. Scrollbar = loam thumb on deep sand.

## Copy
Plain, specific, the product's own words. No eyebrows or kickers above headings. Headings name things ("The colony", "Jobs"). Buttons are a verb and an object ("Drop job in", "Back Scout", "Post the job"). Every number shown is read from the chain or from a reproducible simulation.
