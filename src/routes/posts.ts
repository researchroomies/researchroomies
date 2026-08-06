import { getSessionUser, sessionUserId } from "../lib/session";
import { escapeHtml, renderFullPage } from "../lib/html";

interface PostForEdit {
  id: number;
  title: string;
  description: string;
  user_id: number;
  conference_id: number;
  conference_name: string;
}

interface PostOwner {
  id: number;
  user_id: number;
}

interface PostForDelete {
  id: number;
  title: string;
  user_id: number;
}

function parsePostId(params?: Record<string, string>): number | null {
  const raw = params?.id;
  if (!raw) return null;
  const id = parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

function notFoundPage(): Response {
  return new Response(
    renderFullPage(
      "Post Not Found",
      `<div class="site-page"><h2>Post Not Found</h2><p>The requested post could not be found.</p></div>`,
    ),
    { status: 404, headers: { "Content-Type": "text/html" } },
  );
}

function forbiddenPage(): Response {
  return new Response(
    renderFullPage(
      "Forbidden",
      `<div class="site-page"><h2>Forbidden</h2><p>You can only edit your own posts.</p></div>`,
    ),
    { status: 403, headers: { "Content-Type": "text/html" } },
  );
}

function errorPage(): Response {
  return new Response(
    renderFullPage(
      "Error",
      `<div class="site-page"><h2>Error</h2><p>Something went wrong. Please try again later.</p></div>`,
    ),
    { status: 500, headers: { "Content-Type": "text/html" } },
  );
}

export async function handleEditPostForm(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.redirect(new URL("/login", request.url).href, 302);
  }

  const id = parsePostId(params);
  if (id === null) {
    return notFoundPage();
  }

  try {
    const post = await env.DB.prepare(
      `
      SELECT p.id, p.title, p.description, p.user_id, p.conference_id, c.name AS conference_name
      FROM posts p
      JOIN conferences c ON p.conference_id = c.id
      WHERE p.id = ?
    `,
    )
      .bind(id)
      .first<PostForEdit>();

    if (!post) {
      return notFoundPage();
    }

    if (post.user_id !== sessionUserId(user)) {
      return forbiddenPage();
    }

    const content = `
      <div class="site-page">
        <h2>Edit Post</h2>
        <form action="/post/${id}/edit" method="POST">
          <label>Conference</label>
          <input type="text" value="${escapeHtml(post.conference_name)}" disabled />

          <label>Post Title</label>
          <input type="text" name="title" value="${escapeHtml(post.title)}" required />

          <label>Description</label>
          <textarea name="description" rows="6" required>${escapeHtml(post.description)}</textarea>

          <button type="submit">Save Changes</button>
        </form>
        <p><a href="/post/${id}">Cancel</a></p>
      </div>
    `;

    return new Response(renderFullPage("Edit Post", content), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    console.error("Error loading post for edit:", error);
    return errorPage();
  }
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

  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.redirect(new URL("/login", request.url).href, 302);
  }

  const id = parsePostId(params);
  if (id === null) {
    return notFoundPage();
  }

  try {
    const post = await env.DB.prepare(`SELECT id, user_id FROM posts WHERE id = ?`)
      .bind(id)
      .first<PostOwner>();

    if (!post) {
      return notFoundPage();
    }

    if (post.user_id !== sessionUserId(user)) {
      return forbiddenPage();
    }

    const formData = await request.formData();
    const title = (formData.get("title") as string | null)?.trim() || "";
    const description =
      (formData.get("description") as string | null)?.trim() || "";

    if (!title || !description) {
      return new Response("Missing required fields", { status: 400 });
    }

    // The user_id check here is defence in depth on top of the explicit
    // ownership check above — an id can never be trusted from the form body.
    await env.DB.prepare(
      `UPDATE posts SET title = ?, description = ? WHERE id = ? AND user_id = ?`,
    )
      .bind(title, description, id, sessionUserId(user))
      .run();

    return Response.redirect(new URL(`/post/${id}`, request.url).href, 303);
  } catch (error) {
    console.error("Error updating post:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

export async function handleDeletePostConfirm(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.redirect(new URL("/login", request.url).href, 302);
  }

  const id = parsePostId(params);
  if (id === null) {
    return notFoundPage();
  }

  try {
    const post = await env.DB.prepare(
      `SELECT id, title, user_id FROM posts WHERE id = ?`,
    )
      .bind(id)
      .first<PostForDelete>();

    if (!post) {
      return notFoundPage();
    }

    if (post.user_id !== sessionUserId(user)) {
      return forbiddenPage();
    }

    const content = `
      <div class="site-page">
        <h2>Delete Post</h2>
        <p>Are you sure you want to delete <strong>${escapeHtml(post.title)}</strong>? This action cannot be undone.</p>
        <form action="/post/${id}/delete" method="POST">
          <button type="submit" class="danger-button">Delete permanently</button>
        </form>
        <p><a href="/post/${id}">Cancel</a></p>
      </div>
    `;

    return new Response(renderFullPage("Delete Post", content), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    console.error("Error loading post for delete confirmation:", error);
    return errorPage();
  }
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

  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.redirect(new URL("/login", request.url).href, 302);
  }

  const id = parsePostId(params);
  if (id === null) {
    return notFoundPage();
  }

  try {
    const post = await env.DB.prepare(`SELECT id, user_id FROM posts WHERE id = ?`)
      .bind(id)
      .first<PostOwner>();

    if (!post) {
      return notFoundPage();
    }

    if (post.user_id !== sessionUserId(user)) {
      return forbiddenPage();
    }

    const userId = sessionUserId(user);

    // flags reference the post and would otherwise dangle; message rows are
    // deliberately left alone as the historical record of inquiries sent.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM flags WHERE post_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM posts WHERE id = ? AND user_id = ?`).bind(
        id,
        userId,
      ),
    ]);

    return Response.redirect(new URL("/my-posts", request.url).href, 303);
  } catch (error) {
    console.error("Error deleting post:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
