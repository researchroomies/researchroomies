import { sessionUserId } from "../lib/session";
import { optionalUser } from "../lib/guards";
import { turnstileWidget } from "../lib/turnstile";
import {
  escapeHtml,
  formatDate,
  formatDateRange,
  summarize,
} from "../lib/html";
import {
  errorPage,
  fragmentResponse,
  notFoundPage,
  pageResponse,
} from "../lib/response";
import { parseRouteId } from "../lib/params";
import { getPostWithConference } from "../db/posts";
import { listShareTypesForPost } from "../db/share-types";
import { shareTypeBadges } from "../lib/share-types";
import { positionLabel } from "../lib/positions";
import { ARCHIVED_NOTICE, isArchived } from "../lib/archive";
import type { PostDetail, ShareType } from "../db/types";

/**
 * Reading a post: the `/post/:id` page and its HTMX fragment twin.
 *
 * These two live together because they are one rendering with two envelopes —
 * `renderPostDetail()` is the shared body, and keeping it private to this file
 * is what lets the split hold its rule that no route module imports another.
 * The authoring side of a post is elsewhere — create-post.ts writes one,
 * posts.ts edits and deletes one, my-posts.ts lists your own; everything here
 * renders for anonymous viewers too.
 */

/** The conference link, the author, the dates and the posting date, as stated facts. */
function renderFacts(post: PostDetail): string {
  const location = post.location_address
    ? `<dt>Location</dt><dd>${escapeHtml(post.location_address)}</dd>`
    : "";

  // Two rows rather than one byline, because this list is where a reader checks
  // a claim rather than skims it, and because either half can be absent: the
  // columns are nullable and the posts written before the fields existed have
  // neither. Omitted entirely rather than rendered as "—" — a row promising a
  // fact the post does not carry is worse than no row.
  const position = positionLabel(post);
  const author =
    (position ? `<dt>Position</dt><dd>${escapeHtml(position)}</dd>` : "") +
    (post.institution
      ? `<dt>Institution</dt><dd>${escapeHtml(post.institution)}</dd>`
      : "");

  return `
        <dl class="post-facts">
          <dt>Conference</dt>
          <dd><a href="/conference/${encodeURIComponent(post.conference_slug)}">${escapeHtml(post.conference_name)}</a></dd>
          ${author}
          <dt>Dates</dt><dd class="tnum">${formatDateRange(post.start_time, post.stop_time)}</dd>
          ${location}
          <dt>Posted</dt><dd class="tnum">${formatDate(post.created_at)}</dd>
        </dl>`;
}

/** The inquiry box in the aside: the form for a reader, a prompt for a stranger. */
function renderInquiry(
  env: Env,
  post: PostDetail,
  isLoggedIn: boolean,
  archived: boolean,
): string {
  // Closed before the sign-in prompt, because sending someone to /login for a
  // form they will not get either way is the worse of the two dead ends.
  if (archived) {
    return `
          <div class="aside-box">
            <h4>Inquiries are closed</h4>
            <p class="aside-note">${escapeHtml(ARCHIVED_NOTICE)}</p>
            <a href="/conferences" class="btn btn-secondary btn-block">Find an upcoming conference</a>
          </div>`;
  }

  if (!isLoggedIn) {
    return `
          <div class="aside-box">
            <h4>Send an inquiry</h4>
            <p class="aside-note">Sign in with your institutional email to message the author. No password — we send a link.</p>
            <a href="/login" class="btn btn-primary btn-block">Log in to send an inquiry</a>
          </div>`;
  }

  return `
          <div class="aside-box">
            <h4>Send an inquiry</h4>
            <p class="aside-note">Say who you are and which part you're interested in. Your email is shared with the author so they can reply.</p>
            <form action="/api/message/send" method="POST" class="form-stack">
              <input type="hidden" name="post_id" value="${post.id}" />
              <div class="field">
                <label for="inquiry-content">Message</label>
                <textarea class="input" id="inquiry-content" name="content" rows="5" required></textarea>
              </div>
              ${turnstileWidget(env)}
              <button class="btn btn-primary btn-block" type="submit">Send message</button>
            </form>
          </div>`;
}

function renderPostDetail(
  env: Env,
  post: PostDetail,
  shareTypes: ShareType[],
  viewer: { isLoggedIn: boolean; isAuthor: boolean; sent: boolean },
): string {
  const archived = isArchived(post);

  // Both variants point at the report route; only the label and the target
  // differ. Anonymous, the route 302s to /login and the magic-link callback
  // lands on the homepage rather than back here, so a same-tab click costs the
  // reader the post they were looking at. Opening a new tab keeps this one, and
  // the second click — cookie now set — reaches the form directly. The label
  // says so up front instead of letting the login bounce be the explanation.
  const reportAction = viewer.isLoggedIn
    ? `<a href="/post/${post.id}/report" class="report-link">Report this post</a>`
    : `<a href="/post/${post.id}/report" class="report-link" target="_blank">Log in to report this post</a>`;

  // Delete survives archiving and edit does not — see src/lib/archive.ts. The
  // button is dropped rather than shown and refused, so the page never offers an
  // action the guard behind it would 403.
  const editAction = archived
    ? ""
    : `<a href="/post/${post.id}/edit" class="btn btn-secondary">Edit post</a>`;

  const ownerActions = viewer.isAuthor
    ? `
        <div class="post-actions">
          ${editAction}
          <a href="/post/${post.id}/delete" class="btn btn-ghost danger-link">Delete</a>
          <span class="post-actions-note">This is your post. <a href="/my-posts">See all your posts</a></span>
        </div>
      `
    : `
        <div class="post-actions">
          ${reportAction}
        </div>
      `;

  const sentNotice = viewer.sent
    ? `<p class="form-notice">Your inquiry was sent. The post author has your email address and can reply directly.</p>`
    : "";

  // Stated at the top of the article as well as in the aside: a reader arriving
  // from a search result needs to know the trip is over before they read the
  // offer, not after they go looking for the button that is missing.
  const archivedNotice = archived
    ? `<p class="form-notice">${escapeHtml(ARCHIVED_NOTICE)}</p>`
    : "";

  return `
      <p class="breadcrumb"><a href="/conferences">Conferences</a> &nbsp;/&nbsp; <a href="/conference/${encodeURIComponent(post.conference_slug)}">${escapeHtml(post.conference_name)}</a> &nbsp;/&nbsp; Post</p>
      <div class="with-aside">
        <article class="post-body">
          <h1 class="post-title">${escapeHtml(post.title)}</h1>
          ${archivedNotice}
          ${shareTypeBadges(shareTypes)}
          ${renderFacts(post)}
          <p>${escapeHtml(post.description)}</p>
          ${ownerActions}
        </article>
        <aside class="aside-stack">
          ${sentNotice}
          ${renderInquiry(env, post, viewer.isLoggedIn, archived)}
          <div class="aside-section">
            <p class="aside-note">We don't verify or endorse users. Verify institutional affiliation and read the <a href="/safety">Safety &amp; Scam Awareness Guide</a> before you arrange anything.</p>
          </div>
        </aside>
      </div>
    `;
}

/**
 * GET /post/:id — server-rendered.
 *
 * This used to serve a static shell whose inline script re-parsed the id out of
 * window.location and fetched /api/components/post/:id, costing three round
 * trips to show the site's primary entity and leaving crawlers and link
 * unfurlers with "Loading post details...". The Worker already has the id in
 * params, so it renders the post directly, with a real title and description.
 */
export async function handlePostPage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const postId = parseRouteId(params?.id);
  if (postId === null) {
    return notFoundPage("Post");
  }

  try {
    const post = await getPostWithConference(env, postId);

    if (!post) {
      return notFoundPage("Post");
    }

    const [user, shareTypes] = await Promise.all([
      optionalUser(request, env),
      listShareTypesForPost(env, post.id),
    ]);
    const url = new URL(request.url);

    const content = renderPostDetail(env, post, shareTypes, {
      isLoggedIn: user !== null,
      isAuthor: user !== null && sessionUserId(user) === post.user_id,
      sent: url.searchParams.get("sent") === "1",
    });

    // Varies by viewer (author actions, logged-out prompt) — never shared, which
    // is pageResponse()'s default.
    return pageResponse(post.title, content, {
      description: summarize(`${post.description} · ${post.conference_name}`),
      canonicalUrl: `${url.origin}/post/${post.id}`,
    });
  } catch (error) {
    console.error("Error fetching post:", error);
    return errorPage();
  }
}

/**
 * GET /api/components/post/:id — the same body as an HTMX fragment.
 *
 * Nothing in the current templates requests this any more; it is kept so that
 * an old post shell still sitting in a browser cache degrades to a working
 * page rather than a dead fetch.
 */
export async function handleComponentPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const postId = parseRouteId(params?.id);
  if (postId === null) {
    return fragmentResponse("<p>Post not found.</p>", {
      status: 404,
      cache: "none",
    });
  }

  try {
    const post = await getPostWithConference(env, postId);

    if (!post) {
      return fragmentResponse("<p>Post not found.</p>", {
        status: 404,
        cache: "none",
      });
    }

    const [user, shareTypes] = await Promise.all([
      optionalUser(request, env),
      listShareTypesForPost(env, post.id),
    ]);

    const html = renderPostDetail(env, post, shareTypes, {
      isLoggedIn: user !== null,
      isAuthor: user !== null && sessionUserId(user) === post.user_id,
      sent: new URL(request.url).searchParams.get("sent") === "1",
    });

    // Varies by viewer (author actions, logged-out prompt) — never shared.
    return fragmentResponse(html);
  } catch (error) {
    console.error("Error fetching post:", error);
    return fragmentResponse("<p>Error loading post.</p>", {
      status: 500,
      cache: "none",
    });
  }
}
