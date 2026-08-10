# Task 4 — Collapse the two page shells into one

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

- [ ] Exactly one literal `<!DOCTYPE html>` in the repository.
- [ ] Static and Worker-rendered pages produce **byte-identical `<head>` and
      `<footer>`** given the same inputs. Assert this in a test that renders both
      and diffs them — this test is what replaces the prose instruction.
- [ ] The `{{ year }}` bug is fixed:
      `npm run build && grep -c "© 2026" public/about/index.html` returns `1`.
- [ ] Static pages get description / OpenGraph meta, or the shell documents
      clearly why a given page does not.
- [ ] Page titles use one separator character throughout.
- [ ] **The "keep the two navs in sync" instruction is deleted** from both
      `CLAUDE.md` and the doc comment in `src/lib/html.ts`. The task is not done
      while that sentence is still load-bearing.

---

## Verification

```bash
guix shell --container --emulate-fhs --network \
  node bash coreutils grep curl sed gawk findutils nss-certs \
  -- bash -c 'npm run build && npx vitest run'
```

Then diff by hand, with `wrangler dev` running:

```bash
curl -s localhost:8788/about  | sed -n '/<head>/,/<\/head>/p' > /tmp/static.html
curl -s localhost:8788/search | sed -n '/<head>/,/<\/head>/p' > /tmp/worker.html
diff /tmp/static.html /tmp/worker.html   # should differ only in title and meta
```

Confirm the nav renders identically on a static page (`/about`) and a
Worker-rendered page (`/my-posts`), both logged in and logged out.
