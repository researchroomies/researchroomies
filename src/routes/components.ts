import { optionalUser, requireUser } from "../lib/guards";
import { escapeHtml, formatDay, formatYear, summarize } from "../lib/html";
import { fragmentResponse } from "../lib/response";
import { listConferences } from "../db/conferences";
import { listTags } from "../db/tags";
import { listRecentPosts } from "../db/posts";
import { listShareTypesForPosts } from "../db/share-types";
import { renderShareTypePicker, shareTypeBadges } from "../lib/share-types";
import { authorLine, renderAuthorFields } from "../lib/positions";

/**
 * `/api/components/*` — HTMX fragments: raw HTML, never JSON, never a full page.
 *
 * These are the small pieces the static Eleventy pages and the Worker-rendered
 * shell fill in after load. The cache argument is the thing to get right in this
 * file: a fragment that varies by session must stay `private` (the default),
 * and only the genuinely shared lists opt into `public-*`.
 *
 * `/api/components/post/:id` is the one component route that is NOT here — it
 * shares `renderPostDetail()` with the `/post/:id` page and lives beside it in
 * post-detail.ts, because a route module must not import another route module.
 */

export async function handleComponentCreateFormAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 'htmx': this is swapped into a live page, so the redirect has to travel as
  // a header on a 200 rather than as a 302 the fetch would follow invisibly.
  const guard = await requireUser(request, env, "htmx");
  if (!guard.ok) return guard.response;
  const user = guard.value;

  const html = `<div id="auth-email-container" class="field"><label>Email</label><input class="input" type="email" name="email" value="${escapeHtml(user.email)}" readonly /></div>`;
  // Contains the viewer's own email address — private is the default here.
  return fragmentResponse(html);
}

export async function handleComponentConferenceOptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const conferences = await listConferences(env);
    const optionsHtml = conferences
      .map(
        (conf) =>
          `<option value="${conf.id}">${escapeHtml(conf.name)}</option>`,
      )
      .join("");
    const html =
      optionsHtml + '<option value="new">Create New Conference</option>';

    return fragmentResponse(html, { cache: "public-short" });
  } catch (error) {
    console.error("Error fetching conferences:", error);
    return fragmentResponse(
      '<option value="new">Error loading conferences. Create New Conference.</option>',
      { status: 500, cache: "none" },
    );
  }
}

/** Subject links in the nav, shared by base.njk and renderFullPage(). */
export async function handleComponentNavSubjects(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const tags = await listTags(env);
    const html = tags
      .map(
        (tag) =>
          `<a href="/subject/${encodeURIComponent(tag.slug)}" class="nav-subject">${escapeHtml(tag.name)}</a>`,
      )
      .join("");

    return fragmentResponse(html, { cache: "public-long" });
  } catch (error) {
    console.error("Error fetching nav subjects:", error);
    return fragmentResponse("", { cache: "none" });
  }
}

/** `<option>` list for the subject filters and the create-post subject picker. */
export async function handleComponentTagOptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const includeBlank = url.searchParams.get("blank") !== "0";
  const selected = url.searchParams.get("selected") || "";

  try {
    const tags = await listTags(env);
    const blank = includeBlank ? '<option value="">Subject</option>' : "";
    const html =
      blank +
      tags
        .map(
          (tag) =>
            `<option value="${escapeHtml(tag.slug)}"${tag.slug === selected ? " selected" : ""}>${escapeHtml(tag.name)}</option>`,
        )
        .join("");

    return fragmentResponse(html, { cache: "public-long" });
  } catch (error) {
    console.error("Error fetching tag options:", error);
    return fragmentResponse('<option value="">Subject</option>', {
      status: 500,
      cache: "none",
    });
  }
}

/**
 * The share-type checkboxes for the create-post form.
 *
 * The create page is a static Eleventy asset, so it cannot render the curated
 * list itself; the edit form is Worker-rendered and calls `shareTypeCheckboxes()`
 * directly. Both go through that one helper, so the two forms cannot drift.
 *
 * Nothing here varies by session — it is the same curated list for everyone —
 * so it caches publicly like the other list fragments.
 */
export async function handleComponentShareTypeOptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const html = await renderShareTypePicker(env, null);

  // Empty rather than an error message: the field is optional and this form has
  // not saved anything yet, so a failure here should cost the picker, not the
  // ability to post. The edit form treats the same null as fatal, because there
  // its save is replace-all and a missing picker would clear the post.
  if (html === null) return fragmentResponse("", { status: 500, cache: "none" });

  return fragmentResponse(html, { cache: "public-long" });
}

/**
 * The position dropdown and institution box for the create-post form.
 *
 * Here for the same reason as the share-type picker: the create page is a
 * static Eleventy asset and cannot read the curated list itself, while the edit
 * form is Worker-rendered and calls `renderAuthorFields()` directly. One helper,
 * so the two forms cannot drift on a field that is mandatory in both.
 *
 * The failure path is the opposite of `handleComponentShareTypeOptions()`, and
 * deliberately so. That one degrades to an empty picker because share types are
 * optional. These fields are required, so a form without them cannot be
 * submitted at all — better to say so where the fields belong than to let
 * someone write a post and lose it to a 400.
 */
export async function handleComponentPositionFields(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const html = await renderAuthorFields(env, null);

  if (html === null) {
    return fragmentResponse(
      `<p class="form-notice">Could not load the position list. Reload the page before posting — a post needs your position and institution.</p>`,
      { status: 500, cache: "none" },
    );
  }

  // The same curated list for everyone; nothing here varies by session.
  return fragmentResponse(html, { cache: "public-long" });
}

/** How many posts the homepage feed shows before deferring to `/search`. */
const FEED_LIMIT = 6;

/**
 * The homepage's "recent posts, all conferences" feed.
 *
 * Each row is led by a date rail carrying the *conference's* opening date, not
 * the post's — that is the date a reader is scanning for, and the post's own
 * `created_at` is already in the meta line as "Posted …". The rail says which
 * trip this is about; the meta line says how fresh the offer is.
 *
 * Badges come from one `listShareTypesForPosts()` call for the whole feed
 * rather than one query per row, the same rule `/search` follows.
 */
export async function handleComponentRecentPosts(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const posts = await listRecentPosts(env, FEED_LIMIT);

    if (posts.length === 0) {
      return fragmentResponse(
        `<p class="empty-state">No posts yet. <a href="/create">Create the first one</a>.</p>`,
        { cache: "public-short" },
      );
    }

    const shareTypes = await listShareTypesForPosts(
      env,
      posts.map((post) => post.id),
    );

    const rows = posts
      .map(
        (post) => `
        <article class="feed-item">
          <div class="feed-date">
            <div class="feed-date-day">${escapeHtml(formatDay(post.start_time))}</div>
            <div class="feed-date-year">${escapeHtml(formatYear(post.start_time))}</div>
          </div>
          <div>
            <div class="card-kicker">${escapeHtml(post.conference_name)}${post.location_address ? ` · ${escapeHtml(post.location_address)}` : ""}</div>
            <h3 class="listing-title"><a href="/post/${post.id}">${escapeHtml(post.title)}</a></h3>
            ${authorLine(post)}
            <p class="listing-excerpt">${escapeHtml(summarize(post.description, 180))}</p>
            ${shareTypeBadges(shareTypes.get(post.id) ?? [])}
            <div class="listing-meta">
              <a href="/conference/${encodeURIComponent(post.conference_slug)}">All posts for this conference</a>
            </div>
          </div>
        </article>
      `,
      )
      .join("");

    const html = `${rows}
      <div class="listing-more"><a href="/search" class="btn btn-secondary">Show more posts</a></div>`;

    // The same list for everyone, and it changes only when someone posts.
    return fragmentResponse(html, { cache: "public-short" });
  } catch (error) {
    console.error("Error loading recent posts:", error);
    return fragmentResponse(
      `<p class="empty-state">Could not load recent posts. <a href="/search">Search instead</a>.</p>`,
      { status: 500, cache: "none" },
    );
  }
}

export async function handleComponentNavUser(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const user = await optionalUser(request, env);

  const html = user
    ? `<a href="/my-posts" class="nav-link">My posts</a> <a href="#" hx-post="/api/auth/logout" class="nav-link">Sign out</a>`
    : `<a href="/login" class="nav-link">Sign in</a>`;

  // The whole point of this fragment is that it differs per session. It must
  // never be cached publicly — which is why 'private' is the default.
  return fragmentResponse(html);
}
