# Frontend Static Asset Templates

`layouts/base.njk` is **generated** from `renderShell()` in `src/lib/shell.mjs`
by `scripts/gen-layout.mjs`, which runs ahead of Eleventy in `npm run build`.
Edits to it are overwritten by the next build and rejected by
`test/shell.test.ts`. Change the page chrome in `src/lib/shell.mjs`.

Pages in `pages/` supply `title` (bare — the shell appends the site name) and
`description` as front matter; the shell turns them into `<title>`,
`<meta name="description">`, the OpenGraph tags and `<link rel="canonical">`.
