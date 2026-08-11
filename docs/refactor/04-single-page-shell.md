# Task 4 — Collapse the two page shells into one

> ## ✅ Landed 2026-08-10 — build-time codegen
>
> The recommended approach was taken, not the `.11ty.js` alternative: it leaves
> the nine page bodies untouched, does not depend on Eleventy 3's JS-layout
> resolution, and keeps the Worker path a plain function call.
>
> `src/lib/shell.mjs` (`renderShell`) is now the only page chrome.
> `renderFullPage()` is a 7-line call into it with **signature and behaviour
> unchanged** — which mattered, because Task 1 was concurrently routing 29 call
> sites through it. `scripts/gen-layout.mjs` generates `templates/layouts/base.njk`
> ahead of Eleventy in `npm run build`.
>
> **`base.njk` is committed**, not gitignored, carrying a `{# GENERATED FILE #}`
> banner — so `npx vitest run` works on a fresh clone before anything is built.
> The banner is a Nunjucks comment and costs 0 bytes of output; the built page
> still starts at byte 0 with `<!DOCTYPE html>`.
>
> **One byte-level change worth knowing:** the footer's `&copy;` entity became a
> literal `©`. With the entity, the acceptance criterion's own command
> (`grep -c "© 2026"`) can never return 1. Glyph-identical, byte-different, and
> the page was already UTF-8 with a literal en dash in it.
>
> **Known divergence, documented in the test:** Nunjucks autoescape emits `&#39;`
> for an apostrophe where `escapeHtml()` emits `&#039;`. Same character,
> different bytes — so a static page whose title or description contained an
> apostrophe would not be byte-identical to a Worker page with the same text. No
> current page has one; the test fixtures exercise `& < > "`, where the two agree
> exactly.

**Size:** Small–medium
**Depends on:** nothing
**Risk:** Low, and self-verifying via a diff test

---

## Problem

`renderFullPage()` in `src/lib/html.ts` and `templates/layouts/base.njk` are two
hand-maintained copies of the same page chrome. `CLAUDE.md` instructs
**"change both together."** That instruction *is* the seam — there isn't one in
code.

### It has drifted before

`renderFullPage()` was previously missing `#nav-user-state`, so Worker-rendered
pages showed no login state in the nav while Eleventy pages did.

### It is drifting again right now

After the Round 2 hardening pass, `renderFullPage()` emits:

- `<meta name="description">`
- four OpenGraph tags (`og:title`, `og:description`, `og:type`, `og:url`)
- `<meta name="twitter:card">`
- `<link rel="canonical">`

`base.njk` emits none of them. So every statically built page — About, Terms,
Privacy, Safety, How It Works, the login page, the 404 — has no description and
produces no link preview. The gap widened as a direct result of improving one
side.

### A second live symptom

`base.njk:31` renders `&copy; {{ year }} ResearchRoomies`, but `year` is defined
nowhere — there is no `_data` directory, no `addGlobalData` call in
`eleventy.config.js`, and no front matter supplying it.

**Every Eleventy-built page currently ships `© ResearchRoomies. All rights
reserved.` with a blank year**, while Worker-rendered pages correctly show
`© 2026`. This is in production now.

### A third: the title contract differs

The nine `.njk` pages each write their own complete title *including* the site
suffix:

```njk
{% block title %}About - ResearchRoomies{% endblock %}
```

`renderFullPage()` appends ` – ResearchRoomies` itself, so its callers pass a
bare title. Two different contracts for the same slot. Seven pages use a hyphen,
two use an en dash, and `renderFullPage` uses an en dash.

---

## Recommended approach — generate `base.njk` at build time

Lowest risk. Does not touch the nine page templates.

1. **Move the chrome into `src/lib/shell.mjs`** — plain ESM with no TypeScript
   syntax, so both Eleventy's CJS config and the Worker bundle can load it:

   ```js
   export function renderShell({ title, head = '', content, year }) { /* ... */ }
   ```

2. **`renderFullPage()` in `html.ts` calls it** with real values, keeping its
   current `PageOptions` handling (description / canonicalUrl → meta tags) as the
   `head` argument.

3. **Add `scripts/gen-layout.mjs`**, wired into `npm run build` ahead of
   `eleventy`. It calls `renderShell` with Nunjucks markers as the values:

   ```js
   renderShell({
     title:   '{% block title %}ResearchRoomies{% endblock %}',
     head:    '{% block head %}{% endblock %}',
     content: '{% block content %}{% endblock %}',
     year:    String(new Date().getFullYear()),
   })
   ```

   and writes the result to `templates/layouts/base.njk`.

4. **Either gitignore `templates/layouts/base.njk`, or commit it** with a
   `<!-- GENERATED FILE — edit src/lib/shell.mjs -->` header. State which was
   chosen and why.

5. **Reconcile the title contract**: pages pass a bare title, the shell appends
   the suffix. This fixes the hyphen/en-dash inconsistency as a side effect.
   Requires editing the nine `{% block title %}` lines.

### Alternative — a single JS layout

Cleaner end state, more churn. Convert the nine pages from Nunjucks
`{% extends %}` inheritance to Eleventy front-matter `layout:` pointing at a
`.11ty.js` layout that calls `renderShell` directly. No codegen and no generated
file in the tree, but it rewrites all nine templates.

Reasonable if someone is touching those templates anyway. Otherwise prefer the
codegen approach.

---

## Acceptance criteria

- [x] Exactly one literal `<!DOCTYPE html>` in the repository. — one *authored*
      literal, in `src/lib/shell.mjs`. `git grep` also finds the generated
      `base.njk`, a doc-comment mention, and two test assertions; committing the
      generated file (which this doc permits) makes a second copy unavoidable.
- [x] Static and Worker-rendered pages produce byte-identical `<head>` and
      `<footer>`, asserted by `test/shell.test.ts`, which loads the committed
      `base.njk` via Vite `?raw`, substitutes the generator's own marker strings,
      and `toBe()`-compares head, footer and whole document. A separate assertion
      pins `base.njk === renderLayoutTemplate()`, which is the part with real
      teeth: it fails on a stale or hand-edited layout.
- [x] The `{{ year }}` bug is fixed — `grep -c "© 2026" public/about/index.html`
      returns `1`. (Required the `&copy;` → `©` change noted above.)
- [x] Static pages get description / OpenGraph meta — all 9, each verified
      `desc=1 canon=1`.
- [x] Page titles use one separator character throughout — en dash, owned solely
      by the shell. The test asserts `base.njk` contains no `- ResearchRoomies`.
- [x] **The "keep the two navs in sync" instruction is deleted** — from
      `CLAUDE.md` and `src/lib/html.ts` as required, and also from `AGENTS.md`
      and `README.md`, which carried the same now-false rule.

---

## Verification

```bash
guix shell --container --emulate-fhs --network \
  node bash coreutils grep curl sed gawk findutils nss-certs \
  -- bash -c 'npm run build && npx vitest run'
```

Then diff by hand, with `wrangler dev` running:

```bash
# Note the trailing slash: the asset server 307-redirects /about -> /about/,
# so the slashless form returns an empty body and a useless diff.
curl -s localhost:8788/about/ | sed -n '/<head>/,/<\/head>/p' > /tmp/static.html
curl -s localhost:8788/search | sed -n '/<head>/,/<\/head>/p' > /tmp/worker.html
diff /tmp/static.html /tmp/worker.html   # should differ only in title and meta
```

Confirm the nav renders identically on a static page (`/about/`) and a
Worker-rendered page (`/my-posts`), both logged in and logged out.

**Result:** heads differ only in title and per-page meta. Navs and footers are
byte-identical in all three combinations checked with a minted session cookie —
`/about/` logged-out vs logged-in, `/about/` vs `/my-posts` logged in, `/about/`
vs `/search` logged out. Login state lives entirely in the
`/api/components/nav-user` fragment, which is one handler serving both page
types, so there is no second code path to drift.

### Still open after this task

- **Worker pages vary in whether they set `description` / `canonicalUrl`.** The
  shell omits those tags when a handler passes nothing, which is the case for
  `/search`, `/my-posts` and the edit/delete/report pages. That is per-handler
  content rather than shell shape, so it was out of scope here — but it is the
  remaining half of the meta gap this task set out to close.
- **Unrelated, found while verifying:** `not_found_handling = "404-page"` looks
  for `public/404.html`, but Eleventy emits `public/404/index.html`, so the
  custom 404 page is probably never served. Pre-existing and untouched.
