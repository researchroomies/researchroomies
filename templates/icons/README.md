# Site icons

`favicon.svg` is the source. `favicon.ico` and `apple-touch-icon.png` are
rendered from it and committed, because the deploy runs `npm run build` in an
environment that has no SVG rasteriser — regenerating them at build time would
add a system dependency to `npm run deploy`.

Edit the SVG, then regenerate the other two:

```sh
rsvg-convert -w 180 -h 180 favicon.svg -o apple-touch-icon.png
for s in 16 32 48; do rsvg-convert -w $s -h $s favicon.svg -o /tmp/i$s.png; done
python3 - <<'PY'
import struct
imgs = [(s, open(f"/tmp/i{s}.png", "rb").read()) for s in (16, 32, 48)]
out = struct.pack("<HHH", 0, 1, len(imgs))
off = 6 + 16 * len(imgs)
for s, d in imgs:
    out += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(d), off)
    off += len(d)
out += b"".join(d for _, d in imgs)
open("favicon.ico", "wb").write(out)
PY
```

The `.ico` holds PNG-compressed 16/32/48 frames, which every browser released
this decade reads; it exists for the clients that request `/favicon.ico`
directly rather than as a fallback for anything modern.

The mark is deliberately an opaque cream tile rather than two bare letters: the
ink-colored R is invisible against a dark tab bar on its own, and a tile solves
that in every browser, where a `prefers-color-scheme` block inside the SVG only
works in the ones that honour it.

The three colors are the stylesheet's own tokens — `--color-neutral-100`
(`#f8f4f4`), `--color-text` (`#201f1d`) and `--color-accent` (`#b68235`). They
are hard-coded here because an SVG served as a favicon has no access to
`style.css`; if those tokens change, change them here too.
