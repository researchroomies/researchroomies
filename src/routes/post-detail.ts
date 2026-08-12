import { sessionUserId } from "../lib/session";
import { optionalUser } from "../lib/guards";
import { turnstileWidget } from "../lib/turnstile";
import { escapeHtml, summarize } from "../lib/html";
import {
  errorPage,
  fragmentResponse,
  notFoundPage,
  pageResponse,
} from "../lib/response";
import { parseRouteId } from "../lib/params";
import { getPostWithConference } from "../db/posts";
import type { PostDetail } from "../db/types";

/**
 * Reading a post: the `/post/:id` page and its HTMX fragment twin.
 *
 * These two live together because they are one rendering with two envelopes —
 * `renderPostDetail()` is the shared body, and keeping it private to this file
 * is what lets the split hold its rule that no route module imports another.
 * The authoring side of a post (create, edit, delete, my-posts) is in posts.ts;
 * everything here renders for anonymous viewers too.
 */

function renderPostDetail(
  env: Env,
  post: PostDetail,
  viewer: { isLoggedIn: boolean; isAuthor: boolean; sent: boolean },
): string {
  const formHtml = viewer.isLoggedIn
    ? `
        <form action="/api/message/send" method="POST">
          <input type="hidden" name="post_id" value="${post.id}" />
          <label>Message</label>
          <textarea name="content" rows="5" required></textarea>
          ${turnstileWidget(env)}
          <button type="submit">Send</button>
        </form>
    `
    : `
        <p>Please <a href="/login">log in</a> to send an inquiry.</p>
    `;

  const ownerActions = viewer.isAuthor
    ? `
        <p class="post-actions">
          <a href="/post/${post.id}/edit" class="nav-link">Edit</a>
          <a href="/post/${post.id}/delete" class="nav-link danger-link">Delete</a>
        </p>
      `
    : `
        <p class="post-actions">
          <a href="/post/${post.id}/report" class="report-link">Report this post</a>
        </p>
      `;

  const sentNotice = viewer.sent
    ? `<p class="form-notice">Your inquiry was sent. The post author has your email address and can reply directly.</p>`
    : "";

  return `
      ${sentNotice}
      <article>
        <h2>${escapeHtml(post.title)}</h2>
        <p>${escapeHtml(post.description)}</p>
        <p><strong>Conference:</strong> <a href="/conference/${encodeURIComponent(post.conference_slug)}">${escapeHtml(post.conference_name)}</a></p>
        ${ownerActions}
      </article>
      <section>
        <h3>Send an Inquiry</h3>
        ${formHtml}
      </section>
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

    const user = await optionalUser(request, env);
    const url = new URL(request.url);

    const content = `<div class="site-page">${renderPostDetail(env, post, {
      isLoggedIn: user !== null,
      isAuthor: user !== null && sessionUserId(user) === post.user_id,
      sent: url.searchParams.get("sent") === "1",
    })}</div>`;

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

    const user = await optionalUser(request, env);

    const html = renderPostDetail(env, post, {
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
