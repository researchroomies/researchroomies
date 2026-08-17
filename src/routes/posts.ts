import { sessionUserId } from "../lib/session";
import { escapeHtml } from "../lib/html";
import { errorPage, pageResponse } from "../lib/response";
import { requireOwnedPost, requireUser } from "../lib/guards";
import { verifyTurnstile } from "../lib/turnstile";
import { parseRouteId } from "../lib/params";
import { createPost, deletePostAndFlags, updatePost } from "../db/posts";
import { createConference, reserveSlug } from "../db/conferences";
import { tagConference } from "../db/tags";
import { setShareTypesForPost } from "../db/share-types";
import {
  renderShareTypePicker,
  submittedShareTypes,
} from "../lib/share-types";

/**
 * Authoring a post: create, edit, delete. Every handler here requires a session
 * and changes a post; the *reading* side, which renders for anonymous viewers
 * too, is in post-detail.ts, and the author's own listing is in my-posts.ts.
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

    const postId = await createPost(env, {
      userId,
      conferenceId: parsedConferenceId,
      title,
      description,
      createdAt: now,
    });

    // Share types are post-level and optional. setShareTypesForPost() drops any
    // slug outside the curated list, and writes nothing when none were checked.
    await setShareTypesForPost(env, postId, submittedShareTypes(formData));

    return Response.redirect(`${new URL(request.url).origin}/my-posts`, 303);
  } catch (err) {
    console.error("Error creating post:", err);
    return new Response("Internal Server Error", { status: 500 });
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

  // This picker is what keeps share types from repeating the subject-tag
  // mistake: subjects can only ever be set while creating a conference, so the
  // ones that predate the feature are untaggable and /search?tag= finds nothing.
  // Every post can be typed here, whenever it was written. null is a read
  // failure, and must not degrade into a form whose save would clear the post.
  const pickerHtml = await renderShareTypePicker(env, post.id);
  if (pickerHtml === null) return errorPage();

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

    // updatePost() keeps the user_id in its WHERE as defence in depth on top of
    // requireOwnedPost() — an id can never be trusted from the form body.
    await updatePost(env, post.id, sessionUserId(user), { title, description });

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
