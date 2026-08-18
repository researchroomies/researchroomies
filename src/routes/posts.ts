import { sessionUserId } from "../lib/session";
import { escapeHtml } from "../lib/html";
import { errorPage, pageResponse } from "../lib/response";
import { requireOwnedPost } from "../lib/guards";
import { deletePostAndFlags, updatePost } from "../db/posts";
import { setShareTypesForPost } from "../db/share-types";
import { renderShareTypePicker, submittedShareTypes } from "../lib/share-types";
import { readAuthorFields, renderAuthorFields } from "../lib/positions";

/**
 * Changing a post you already own: edit and delete.
 *
 * The seam against create-post.ts is `requireOwnedPost()`. Every handler here
 * starts from a post that exists and belongs to the caller, and touches nothing
 * but that post; creating one starts from a session and may write a conference,
 * its subjects and a post before it is done. Adding the position and institution
 * fields pushed the combined file to 360 lines, past the 320 the route-module
 * test allows, and this is the seam it asked for — the same reasoning that moved
 * /my-posts out when share-type badges pushed it over.
 *
 * The *reading* side, which renders for anonymous viewers too, is in
 * post-detail.ts; the author's own listing is in my-posts.ts.
 *
 * All three handlers here are "session → parse id → fetch post → compare
 * user_id", which used to be written out by hand. `requireOwnedPost()` is that
 * sequence; its 302 / 404 / 403 responses are the ones these handlers returned
 * themselves, and it catches its own D1 errors, so none of them needs a `try`
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

  // This picker is what keeps share types from repeating the subject-tag
  // mistake: subjects can only ever be set while creating a conference, so the
  // ones that predate the feature are untaggable and /search?tag= finds nothing.
  // Every post can be typed here, whenever it was written. null is a read
  // failure, and must not degrade into a form whose save would clear the post.
  const pickerHtml = await renderShareTypePicker(env, post.id);
  if (pickerHtml === null) return errorPage();

  // Fatal for the same reason on both forms: these fields are required, so a
  // form missing them is one whose save can only 400. Pre-filled from the post,
  // which is how a post written before the fields existed gets completed — the
  // dead-population problem subject tags still have.
  const authorHtml = await renderAuthorFields(env, post);
  if (authorHtml === null) return errorPage();

  const content = `
    <div class="form-page">
      <div class="page-head">
        <div>
          <h1 class="page-title">Edit post</h1>
          <p class="page-lede">Changing what you're sharing replaces the whole set — whatever is ticked when you save is what the post offers.</p>
        </div>
      </div>
      <form action="/post/${post.id}/edit" method="POST" class="form-stack">
        <div class="field">
          <label for="edit-conference">Conference</label>
          <input class="input" id="edit-conference" type="text" value="${escapeHtml(post.conference_name)}" disabled />
        </div>

        <div class="field">
          <label for="edit-title">Post title</label>
          <input class="input" id="edit-title" type="text" name="title" value="${escapeHtml(post.title)}" required />
        </div>

        <div class="field">
          <label for="edit-description">Description</label>
          <textarea class="input" id="edit-description" name="description" rows="6" required>${escapeHtml(post.description)}</textarea>
        </div>

        ${authorHtml}

        ${pickerHtml}

        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Save changes</button>
          <a href="/post/${post.id}" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>
  `;

  return pageResponse("Edit post", content);
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

    const author = await readAuthorFields(env, formData);
    if (!author.ok) return author.response;

    // updatePost() keeps the user_id in its WHERE as defence in depth on top of
    // requireOwnedPost() — an id can never be trusted from the form body.
    await updatePost(env, post.id, sessionUserId(user), {
      title,
      description,
      position: author.position,
      institution: author.institution,
    });

    // Replace, not add: unchecked boxes submit nothing, so an add-only write
    // would make removing a share type impossible. Ownership is already settled
    // by requireOwnedPost() above.
    await setShareTypesForPost(env, post.id, submittedShareTypes(formData));

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
    <div class="form-page">
      <div class="page-head">
        <div><h1 class="page-title">Delete post</h1></div>
      </div>
      <p class="confirm-warning">Are you sure you want to delete <strong>${escapeHtml(post.title)}</strong>? This cannot be undone, and anyone who has written to you about it will have nothing to link back to.</p>
      <form action="/post/${post.id}/delete" method="POST" class="form-actions">
        <button type="submit" class="btn btn-danger">Delete permanently</button>
        <a href="/post/${post.id}" class="btn btn-ghost">Cancel</a>
      </form>
    </div>
  `;

  return pageResponse("Delete post", content);
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
