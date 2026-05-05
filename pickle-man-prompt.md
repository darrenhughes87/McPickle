# McPICKLES — Pickle Man Logo Generation Guide

The mascot for McPICKLES is a humanized pickle character in a retro 1950s/60s ska style.
Use the prompts below with your preferred AI image generator, then trace to SVG for use as the app icon.

---

## Midjourney Prompt (Recommended)

```
/imagine prompt: cartoon mascot character, anthropomorphized green pickle/gherkin wearing a pork pie hat with black-and-white checkerboard band, holding a pickleball paddle, big cheeky grin with googly eyes, wearing a sleeveless vest with checkerboard trim, retro 1950s ska/two-tone illustration style, bold black outlines, flat color design, pickle green and black and white color palette, white background, logo-ready vector style, clean simple shapes, vintage cartoon energy --ar 1:1 --style raw --v 6
```

**Variations to try:**
- Add `--chaos 20` for more exaggerated expressions
- Try `--ar 1:1 --style raw --v 6 --no shadow` for a cleaner result
- For full-body: add `full body character, standing pose, arms wide, energetic`

---

## DALL-E Prompt (Alternative)

```
A cheerful cartoon mascot of an anthropomorphized green pickle/gherkin character. It has large expressive eyes, a wide cheeky grin, stubby arms holding a pickleball paddle. It wears a small pork pie hat with a black and white checkerboard band and a sleeveless vest with checkerboard trim. Art style: 1950s/60s ska and two-tone graphic design, bold black outlines, flat colors. Colors: pickle green, black, white, cream. White background. Logo-ready illustration, suitable for use as an app icon.
```

---

## Adobe Firefly / Canva AI Prompt

```
Retro 1950s cartoon pickle character mascot, pork pie hat, checkerboard pattern, holding pickleball paddle, big smile, ska music style, bold outlines, flat colors, green and black, white background, logo design
```

---

## Color Reference

| Element | Hex |
|---------|-----|
| Pickle skin (main) | `#4A7C59` |
| Pickle skin (highlight) | `#8DB87B` |
| Pickle skin (shadow) | `#2D5038` |
| Outline | `#1A1A1A` |
| Hat / vest checkerboard dark | `#1A1A1A` |
| Hat / vest checkerboard light | `#FFFFFF` |
| Eyes (white) | `#F5F0E8` |
| Eyes (pupil) | `#1A1A1A` |

---

## Converting to SVG

Once you have the image:

1. **Vectorize** using one of:
   - [Vectorizer.ai](https://vectorizer.ai) — free, excellent for cartoons
   - Adobe Illustrator → Image Trace → High Fidelity Photo
   - Inkscape → Path → Trace Bitmap

2. **Clean up** in Inkscape or Figma:
   - Remove background
   - Simplify paths (Path → Simplify in Inkscape)
   - Merge fill colors to the reference palette above

3. **Target spec** for `public/icon.svg`:
   - Viewbox: `0 0 512 512`
   - File size: under 20KB
   - Must look good at 48px (browser tab), 192px (home screen), 512px (splash)

4. **Replace** `public/icon.svg` in the repo with the final version
5. **Rebuild Docker container**: `docker compose up -d --build`

---

## Name Options

Working title is **McPICKLES**. Alternative being considered: **Pickle McPickle-Face**.

If the name changes, update:
- `public/manifest.json` → `name` and `short_name`
- All page `<title>` tags
- The `<h1>` logo text in each HTML file
- Docker container name in `docker-compose.yml`

---

## Placeholder Icon

Until the final mascot is ready, `public/icon.svg` contains a geometric placeholder:
a dark green shield/oval with "MP" in bold text. This works for PWA installation and
browser tabs while you generate the real character.
