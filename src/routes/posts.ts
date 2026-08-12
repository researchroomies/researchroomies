import { sessionUserId } from "../lib/session";
import { escapeHtml, formatDate, formatDateRange } from "../lib/html";
import { errorPage, pageResponse } from "../lib/response";
import { requireOwnedPost, requireUser } from "../lib/guards";
import { verifyTurnstile } from "../lib/turnstile";
import { parseRouteId } from "../lib/params";
import {
  createPost,
  deletePostAndFlags,
  listPostsForUser,
  updatePost,
} from "../db/posts";
import { createConference, reserveSlug } from "../db/conferences";
import { tagConference } from "../db/tags";

/**
 * Authoring a post: create, list your own, edit, delete. Every handler here
 * requires a session; the *reading* side of a post, which renders for anonymous
 * viewers too, is in post-detail.ts.
 *
 * The four ownership handlers are each "session → parse id → fetch post →
 * compare user_id", which used to be written out four times. `requireOwnedPost()`
 * is that sequence; its 302 / 404 / 403 responses are the ones these handlers
 * returned by hand, and it catches its own D1 errors, so none of them needs a
 * `try` around the lookup.
 */

export async function handleCreatePost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const guard = await requireUser(request, env, "api");
  if (!guard.ok) return guard.response;
  const user = guard.value;

  try {
    const formData = await request.formData();
    let conferenceId = formData.get("conference_id") as string;
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;

    if (!title || !description || !conferenceId) {
      return new Response("Missing required fields", { status: 400 });
    }

    const turnstileOk = await verifyTurnstile(
      formData.get("cf-turnstile-response") as string | null,
      request,
      env,
    );
    if (!turnstileOk) {
      return new Response(
        "Could not verify that you are human. Please reload the page and try again.",
        { status: 400 },
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const userId = sessionUserId(user);

    // KNOWN LIMIT: creating a post against a new conference is three separate
    // writes (conference insert, tag batch, post insert) with no transaction
    // around them. If the post insert fails, the conference survives as an
    // orphan and keeps its slug, so the user's retry gets "-2" appended.
    // The reason D1 cannot fix this is recorded on src/db/conferences.ts.
    if (conferenceId === "new") {
      const newConfName = formData.get("new_conf_name") as string;
      const newConfStartStr = formData.get("new_conf_start") as string;
      const newConfEndStr = formData.get("new_conf_end") as string;
      const newConfCity = formData.get("new_conf_city") as string;
      const newConfState = formData.get("new_conf_state") as string;
      const newConfLocation = [newConfCity, newConfState]
        .filter(Boolean)
        .join(", ");

      if (!newConfName || !newConfStartStr || !newConfEndStr) {
        return new Response("Missing required fields for new conference", {
          status: 400,
        });
      }

      const slug = await reserveSlug(env, newConfName);
      const startTime = Math.floor(new Date(newConfStartStr).getTime() / 1000);
      const stopTime = Math.floor(new Date(newConfEndStr).getTime() / 1000);

      if (!Number.isFinite(startTime) || !Number.isFinite(stopTime)) {
        return new Response("Invalid conference dates", { status: 400 });
      }

      const newConferenceId = await createConference(env, {
        userId,
        name: newConfName,
        slug,
        locationAddress: newConfLocation || null,
        startTime,
        stopTime,
        createdAt: now,
      });
      conferenceId = newConferenceId.toString();

      // Subjects are conference-level. tagConference() drops any slug that is
      // not already in `tags`, which is what keeps the curated list curated.
      const submittedTags = formData
        .getAll("conf_tags")
        .map((value) => String(value).trim())
        .filter(Boolean);

      await tagConference(env, newConferenceId, submittedTags);
    }

    const parsedConferenceId = parseRouteId(conferenceId);
    if (parsedConferenceId === null) {
      return new Response("Invalid conference", { status: 400 });
    }

    await createPost(env, {
      userId,
      conferenceId: parsedConferenceId,
      title,
      description,
      createdAt: now,
    });

    return Response.redirect(`${new URL(request.url).origin}/my-posts`, 303);
  } catch (err) {
    console.error("Error creating post:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}

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

    let postsHtml = "";
    if (results.length === 0) {
      postsHtml = `<p class="empty-state">You haven't created any posts yet. <a href="/create">Create your first post</a></p>`;
    } else {
      postsHtml = `<ul class="my-posts-list">`;
      for (const post of results) {
        postsHtml += `
          <li class="my-post-item">
            <h3><a href="/post/${post.id}">${escapeHtml(post.title)}</a></h3>
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

export async function handleEditPostForm(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const guard = await requireOwnedPost(request, env, params);
  if (!guard.ok) return guard.response;
  const { post } = guard.value;

  const content = `
    <div class="site-page">
      <h2>Edit Post</h2>
      <form action="/post/${post.id}/edit" method="POST">
        <label>Conference</label>
        <input type="text" value="${escapeHtml(post.conference_name)}" disabled />

        <label>Post Title</label>
        <input type="text" name="title" value="${escapeHtml(post.title)}" required />

        <label>Description</label>
        <textarea name="description" rows="6" required>${escapeHtml(post.description)}</textarea>

        <button type="submit">Save Changes</button>
      </form>
      <p><a href="/post/${post.id}">Cancel</a></p>
    </div>
  `;

  return pageResponse("Edit Post", content);
}

export async function handleEditPostSubmit(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const guard = await requireOwnedPost(request, env, params);
  if (!guard.ok) return guard.response;
  const { user, post } = guard.value;

  try {
    const formData = await request.formData();
    const title = (formData.get("title") as string | null)?.trim() || "";
    const description =
      (formData.get("description") as string | null)?.trim() || "";

    if (!title || !description) {
      return new Response("Missing required fields", { status: 400 });
    }

    // updatePost() keeps the user_id in its WHERE as defence in depth on top of
    // requireOwnedPost() — an id can never be trusted from the form body.
    await updatePost(env, post.id, sessionUserId(user), { title, description });

    return Response.redirect(new URL(`/post/${post.id}`, request.url).href, 303);
  } catch (error) {
    console.error("Error updating post:", error);
    return errorPage();
  }
}

export async function handleDeletePostConfirm(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const guard = await requireOwnedPost(request, env, params);
  if (!guard.ok) return guard.response;
  const { post } = guard.value;

  const content = `
    <div class="site-page">
      <h2>Delete Post</h2>
      <p>Are you sure you want to delete <strong>${escapeHtml(post.title)}</strong>? This action cannot be undone.</p>
      <form action="/post/${post.id}/delete" method="POST">
        <button type="submit" class="danger-button">Delete permanently</button>
      </form>
      <p><a href="/post/${post.id}">Cancel</a></p>
    </div>
  `;

  return pageResponse("Delete Post", content);
}

export async function handleDeletePostSubmit(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const guard = await requireOwnedPost(request, env, params);
  if (!guard.ok) return guard.response;
  const { user, post } = guard.value;

  try {
    // Flags reference the post and would otherwise dangle; message rows are
    // deliberately left alone as the historical record of inquiries sent. Both
    // rules, and the defence-in-depth user_id, live in deletePostAndFlags().
    await deletePostAndFlags(env, post.id, sessionUserId(user));

    return Response.redirect(new URL("/my-posts", request.url).href, 303);
  } catch (error) {
    console.error("Error deleting post:", error);
    return errorPage();
  }
}
