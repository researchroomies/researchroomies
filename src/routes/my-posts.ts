import { sessionUserId } from "../lib/session";
import { escapeHtml, formatDate, formatDateRange } from "../lib/html";
import { errorPage, pageResponse } from "../lib/response";
import { requireUser } from "../lib/guards";
import { listPostsForUser } from "../db/posts";
import { listShareTypesForPosts } from "../db/share-types";
import { shareTypeBadges } from "../lib/share-types";
import { authorLine } from "../lib/positions";

/**
 * `GET /my-posts` — the author's own listing.
 *
 * Split out of posts.ts when share-type badges pushed that file over the
 * route-module size bound — the first of two splits that bound has forced, the
 * second being create-post.ts. The seam is the one the bound's own message asks
 * for: the authoring modules *mutate* a post and reach `requireOwnedPost()` or
 * `createPost()`, while this renders a list and reaches `listPostsForUser()`.
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
            <div>
              <h3><a href="/post/${post.id}">${escapeHtml(post.title)}</a></h3>
              ${authorLine(post)}
              ${shareTypeBadges(shareTypes.get(post.id) ?? [])}
              <p class="conference-info">
                <a href="/conference/${encodeURIComponent(post.conference_slug)}">${escapeHtml(post.conference_name)}</a>
                <span class="tnum">${formatDateRange(post.start_time, post.stop_time)}</span>
                <span class="created-info">Posted ${formatDate(post.created_at)}</span>
              </p>
            </div>
            <div class="my-post-actions">
              <a href="/post/${post.id}/edit">Edit</a>
              <a href="/post/${post.id}/delete" class="danger-link">Delete</a>
            </div>
          </li>
        `;
      }
      postsHtml += `</ul>`;
    }

    const upcoming = results.filter(
      (post) => post.stop_time * 1000 >= Date.now(),
    ).length;

    const content = `
      <div class="with-aside">
        <div>
          <div class="page-head">
            <div>
              <h1 class="page-title">My posts</h1>
              <p class="page-lede tnum">${results.length} post${results.length === 1 ? "" : "s"} · ${upcoming} for upcoming conferences</p>
            </div>
            <a href="/create" class="btn btn-primary">New post</a>
          </div>
          ${postsHtml}
        </div>
        <aside class="aside-stack">
          <div class="aside-box">
            <h4>Inquiries</h4>
            <p class="aside-note">Messages come straight to your inbox — <span class="nowrap">${escapeHtml(user.email)}</span> — and you reply by email, not through the site.</p>
          </div>
          <div class="aside-section">
            <h6>Editing a post</h6>
            <p class="aside-note">You can change a post's title, description and what it offers to share at any time. Deleting one is permanent.</p>
          </div>
        </aside>
      </div>
    `;

    return pageResponse("My posts", content);
  } catch (error) {
    console.error("Error fetching my posts:", error);
    return errorPage();
  }
}
