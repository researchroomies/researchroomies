import { sessionUserId } from "../lib/session";
import { escapeHtml, formatDate, formatDateRange } from "../lib/html";
import { errorPage, pageResponse } from "../lib/response";
import { requireUser } from "../lib/guards";
import { listPostsForUser } from "../db/posts";
import { listShareTypesForPosts } from "../db/share-types";
import { shareTypeBadges } from "../lib/share-types";

/**
 * `GET /my-posts` — the author's own listing.
 *
 * Split out of posts.ts when share-type badges pushed that file over the
 * route-module size bound. The seam is the one the bound's own message asks for:
 * everything left in posts.ts *mutates* a post and reaches `requireOwnedPost()`
 * or `createPost()`, while this renders a list and reaches `listPostsForUser()`.
 * It is the same shape of page as `/search`, differing only in that its filter
 * is the session rather than a query string — which is why it takes the whole
 * `PostWithConference` row from the same listing query.
 */
export async function handleMyPosts(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  _params?: Record<string, string>,
): Promise<Response> {
  const guard = await requireUser(request, env, "page");
  if (!guard.ok) return guard.response;
  const user = guard.value;

  try {
    const results = await listPostsForUser(env, sessionUserId(user));
    // One query for the whole page rather than one per row.
    const shareTypes = await listShareTypesForPosts(
      env,
      results.map((post) => post.id),
    );

    let postsHtml = "";
    if (results.length === 0) {
      postsHtml = `<p class="empty-state">You haven't created any posts yet. <a href="/create">Create your first post</a></p>`;
    } else {
      postsHtml = `<ul class="my-posts-list">`;
      for (const post of results) {
        postsHtml += `
          <li class="my-post-item">
            <h3><a href="/post/${post.id}">${escapeHtml(post.title)}</a></h3>
            ${shareTypeBadges(shareTypes.get(post.id) ?? [])}
            <p class="conference-info">
              <a href="/conference/${encodeURIComponent(post.conference_slug)}">${escapeHtml(post.conference_name)}</a>
              &middot; ${formatDateRange(post.start_time, post.stop_time)}
            </p>
            <p class="created-info">Posted on ${formatDate(post.created_at)}</p>
            <p class="post-actions">
              <a href="/post/${post.id}/edit" class="nav-link">Edit</a>
              <a href="/post/${post.id}/delete" class="nav-link danger-link">Delete</a>
            </p>
          </li>
        `;
      }
      postsHtml += `</ul>`;
    }

    const content = `
      <div class="site-page">
        <h1>My Posts</h1>
        ${postsHtml}
      </div>
    `;

    return pageResponse("My Posts", content);
  } catch (error) {
    console.error("Error fetching my posts:", error);
    return errorPage();
  }
}
