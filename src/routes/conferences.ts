import { escapeHtml, formatDate, formatDateRange, summarize } from "../lib/html";
import {
  errorPage,
  fragmentResponse,
  notFoundPage,
  pageResponse,
} from "../lib/response";
import {
  getConferenceBySlug,
  listFeaturedConferences,
} from "../db/conferences";
import { listPostsForConference } from "../db/posts";
import { listTagsForConference } from "../db/tags";
import { listShareTypesForPosts } from "../db/share-types";
import { shareTypeBadges } from "../lib/share-types";
import type {
  Conference,
  ConferenceWithPostCount,
  Post,
  ShareType,
  Tag,
} from "../db/types";

/**
 * One conference: the `/conference/:slug` page and the homepage's featured
 * fragment. The `/conferences` index and its subject grouping live in
 * all-conferences.ts.
 *
 * The render helpers below stay private to this file on purpose. They are used
 * by exactly one handler each, so hoisting them into a shared `render.ts` would
 * buy nothing and recreate `api.ts` at a smaller scale.
 */

function renderTagChips(tags: Tag[]): string {
  if (tags.length === 0) return "";
  const chips = tags
    .map(
      (tag) =>
        `<a href="/subject/${encodeURIComponent(tag.slug)}" class="nav-subject">${escapeHtml(tag.name)}</a>`,
    )
    .join("");
  return `<div class="conference-tags">${chips}</div>`;
}

function renderFeaturedConferences(
  conferences: ConferenceWithPostCount[],
): string {
  if (conferences.length === 0) {
    return `<p class="empty-state">No featured conferences yet. <a href="/conferences">Browse all conferences</a>.</p>`;
  }

  const cards = conferences
    .map(
      (conf) => `
      <a href="/conference/${encodeURIComponent(conf.slug)}" class="card conference-card">
        <div class="card-kicker tnum">${formatDateRange(conf.start_time, conf.stop_time)}</div>
        <div class="card-title">${escapeHtml(conf.name)}</div>
        <p class="card-body">${escapeHtml(conf.location_address || "Location to be announced")}</p>
        <div class="card-meta">
          ${
            conf.post_count === 0
              ? `<span>No posts yet</span>`
              : `<span class="count-open">${conf.post_count} open post${conf.post_count === 1 ? "" : "s"}</span>`
          }
        </div>
      </a>
    `,
    )
    .join("");

  return `<div class="conference-cards">${cards}</div>`;
}

/**
 * The share-type row above a conference's posts.
 *
 * The counts come from the badges already loaded for this page, so the row
 * costs no extra query. Each is a link into `/search` rather than an in-page
 * filter: filtering here would need either a script or a second endpoint, and
 * `/search` is the page that already answers "posts offering a carpool", with
 * every other filter available beside it.
 */
function renderShareFilter(
  conference: Conference,
  posts: Post[],
  shareTypes: Map<number, ShareType[]>,
): string {
  const counts = new Map<string, { name: string; count: number }>();
  for (const post of posts) {
    for (const type of shareTypes.get(post.id) ?? []) {
      const entry = counts.get(type.slug);
      if (entry) entry.count += 1;
      else counts.set(type.slug, { name: type.name, count: 1 });
    }
  }
  if (counts.size === 0) return "";

  const base = `/search?conference=${encodeURIComponent(conference.name)}`;
  const options = [...counts.entries()]
    .map(
      ([slug, { name, count }]) =>
        `<a class="seg-opt" href="${escapeHtml(`${base}&share=${encodeURIComponent(slug)}`)}">${escapeHtml(name)} <span class="seg-count">${count}</span></a>`,
    )
    .join("");

  return `
        <div class="seg section-head-aside">
          <a class="seg-opt" aria-current="page" href="${escapeHtml(base)}">All <span class="seg-count">${posts.length}</span></a>
          ${options}
        </div>`;
}

function renderPostList(
  posts: Post[],
  shareTypes: Map<number, ShareType[]>,
): string {
  if (posts.length === 0) {
    return `<p class="empty-state">No posts for this conference yet. <a href="/create">Post the first one</a>.</p>`;
  }

  return `<div class="listing">${posts
    .map(
      (post) => `
        <article class="listing-item">
          <h3 class="listing-title"><a href="/post/${post.id}">${escapeHtml(post.title)}</a></h3>
          ${shareTypeBadges(shareTypes.get(post.id) ?? [])}
          <p class="listing-excerpt">${escapeHtml(summarize(post.description, 180))}</p>
          <div class="listing-meta">
            <span>Posted ${formatDate(post.created_at)}</span>
            <a href="/post/${post.id}">Reply</a>
          </div>
        </article>
      `,
    )
    .join("")}</div>`;
}

function renderConferencePage(
  conference: Conference,
  posts: Post[],
  tags: Tag[],
  shareTypes: Map<number, ShareType[]>,
): string {
  // No subject in the breadcrumb: a conference can carry several, and picking
  // the first would name one arbitrarily. The chips under the title show them all.
  return `
    <p class="breadcrumb"><a href="/conferences">Conferences</a> &nbsp;/&nbsp; ${escapeHtml(conference.name)}</p>
    <div class="page-head">
      <div>
        <h1 class="page-title">${escapeHtml(conference.name)}</h1>
        ${conference.description ? `<p class="page-lede">${escapeHtml(conference.description)}</p>` : ""}
        ${renderTagChips(tags)}
      </div>
      <dl class="conference-facts">
        <dt>Dates</dt><dd>${formatDateRange(conference.start_time, conference.stop_time)}</dd>
        ${conference.location_address ? `<dt>Location</dt><dd>${escapeHtml(conference.location_address)}</dd>` : ""}
        <dt>Open posts</dt><dd>${posts.length}</dd>
      </dl>
    </div>
    <div class="with-aside">
      <section>
        <div class="section-head">
          <h6>Posts for this conference</h6>
          ${renderShareFilter(conference, posts, shareTypes)}
        </div>
        ${renderPostList(posts, shareTypes)}
      </section>
      <aside class="aside-stack">
        <div class="aside-box">
          <h4>Going to this one?</h4>
          <p class="aside-note">Post what you're willing to share — a spare bed, a seat in the car, or both.</p>
          <a href="/create" class="btn btn-primary btn-block">Post for this conference</a>
        </div>
        <div class="aside-section">
          <h6>Browse</h6>
          <div class="stacked-links">
            <a href="/conferences">All conferences</a>
            <a href="/search">Search every post</a>
          </div>
        </div>
        <div class="aside-section">
          <p class="aside-note">ResearchRoomies doesn't verify or endorse users. Verify who you're dealing with before you share a room or a car. <a href="/safety">Safety &amp; Scam Awareness Guide</a></p>
        </div>
      </aside>
    </div>
  `;
}

export async function handleFeaturedConferences(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const conferences = await listFeaturedConferences(env);
    const html = renderFeaturedConferences(conferences);

    return fragmentResponse(html, { cache: "public-short" });
  } catch (error) {
    console.error("Error fetching featured conferences:", error);
    return fragmentResponse(
      `<p class="empty-state">Error loading featured conferences. Please try again later.</p>`,
      { status: 500, cache: "none" },
    );
  }
}

export async function handleConferencePage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  try {
    const slug = params?.slug;
    if (!slug) {
      // Kept as 400 rather than notFoundPage()'s 404: the route cannot match
      // without a slug segment, so this is an unreachable guard, not a miss.
      return pageResponse(
        "Error",
        `<div class="site-page"><h1>Error</h1><p>Conference slug is required</p></div>`,
        { status: 400, cache: "none" },
      );
    }

    const conference = await getConferenceBySlug(env, decodeURIComponent(slug));
    if (!conference) {
      return notFoundPage("Conference");
    }

    const [posts, tags] = await Promise.all([
      listPostsForConference(env, conference.id),
      listTagsForConference(env, conference.id),
    ]);
    // One query for every badge on the page, as on /search and /my-posts —
    // never listShareTypesForPost() in a loop.
    const shareTypes = await listShareTypesForPosts(
      env,
      posts.map((post) => post.id),
    );
    const content = renderConferencePage(conference, posts, tags, shareTypes);

    return pageResponse(conference.name, content, {
      cache: "public-short",
      description: summarize(
        `${conference.name} — ${conference.location_address || "conference"}, ${formatDateRange(conference.start_time, conference.stop_time)}. ${posts.length} post${posts.length === 1 ? "" : "s"} from academics looking to share travel costs.`,
      ),
      canonicalUrl: `${new URL(request.url).origin}/conference/${encodeURIComponent(conference.slug)}`,
    });
  } catch (error) {
    console.error("Error fetching conference:", error);
    return errorPage();
  }
}
