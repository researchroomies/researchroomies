import { sessionUserId } from "../lib/session";
import { escapeHtml } from "../lib/html";
import { errorPage, pageResponse } from "../lib/response";
import { requireOwnedPost } from "../lib/guards";
import { deletePostAndFlags, updatePost } from "../db/posts";

/**
 * Every handler here is "session → parse id → fetch post → compare user_id",
 * which used to be written out four times. `requireOwnedPost()` is that
 * sequence; its 302 / 404 / 403 responses are the ones these handlers returned
 * by hand, and it catches its own D1 errors, so nothing below needs a `try`
 * around the lookup.
 */

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
