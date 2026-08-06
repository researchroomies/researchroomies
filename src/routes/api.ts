import { sendInquiryEmail } from "../lib/mailgun";
import { getSessionUser, sessionUserId } from "../lib/session";
import { verifyTurnstile } from "../lib/turnstile";
import {
  escapeHtml,
  formatDate,
  formatDateRange,
  renderFullPage,
} from "../lib/html";

interface Conference {
  id: number;
  name: string;
  slug: string;
  location_address: string;
  start_time: number;
  stop_time: number;
  description?: string;
}

interface Post {
  id: number;
  title: string;
  description: string;
  created_at: number;
}

interface Tag {
  slug: string;
  name: string;
}

async function getFeaturedConferences(env: Env): Promise<Conference[]> {
  const stmt = env.DB.prepare(`
    SELECT id, name, slug, location_address, start_time, stop_time
    FROM conferences
    WHERE is_featured = 1
    ORDER BY created_at DESC
    LIMIT 10
  `);

  const result = await stmt.all();
  return result.results as unknown as Conference[];
}

async function getConferenceBySlug(
  env: Env,
  slug: string,
): Promise<Conference | null> {
  const stmt = env.DB.prepare(`
    SELECT id, name, slug, location_address, start_time, stop_time, description
    FROM conferences
    WHERE slug = ?
  `);

  const result = await stmt.bind(slug).first();
  return result as unknown as Conference | null;
}

async function getPostsByConferenceId(
  env: Env,
  conferenceId: number,
): Promise<Post[]> {
  const stmt = env.DB.prepare(`
    SELECT id, title, description, created_at
    FROM posts
    WHERE conference_id = ?
    ORDER BY created_at DESC
  `);

  const result = await stmt.bind(conferenceId).all();
  return result.results as unknown as Post[];
}

async function getAllTags(env: Env): Promise<Tag[]> {
  const result = await env.DB.prepare(
    `SELECT slug, name FROM tags ORDER BY name ASC`,
  ).all<Tag>();
  return result.results ?? [];
}

async function getTagsForConference(
  env: Env,
  conferenceId: number,
): Promise<Tag[]> {
  const result = await env.DB.prepare(
    `
    SELECT tags.slug, tags.name
    FROM conference_tags
    JOIN tags ON conference_tags.tag_slug = tags.slug
    WHERE conference_tags.conference_id = ?
    ORDER BY tags.name ASC
  `,
  )
    .bind(conferenceId)
    .all<Tag>();
  return result.results ?? [];
}

function renderTagChips(tags: Tag[]): string {
  if (tags.length === 0) return "";
  const chips = tags
    .map(
      (tag) =>
        `<a href="/subject/${encodeURIComponent(tag.slug)}" class="nav-subject">${escapeHtml(tag.name)}</a>`,
    )
    .join(" ");
  return `<p class="conference-tags">${chips}</p>`;
}

function renderFeaturedConferences(conferences: Conference[]): string {
  if (conferences.length === 0) {
    return "<p>No featured conferences available at the moment.</p>";
  }

  const items = conferences
    .map(
      (conf) => `
    <li>
      <a href="/conference/${encodeURIComponent(conf.slug)}">
        <strong>${escapeHtml(conf.name)}</strong><br />
        ${escapeHtml(conf.location_address)} (${formatDateRange(conf.start_time, conf.stop_time)})
      </a>
    </li>
  `,
    )
    .join("");

  return `<ul>${items}</ul>`;
}

function renderConferencePage(
  conference: Conference,
  posts: Post[],
  tags: Tag[],
): string {
  const postsHtml =
    posts.length > 0
      ? posts
          .map(
            (post) =>
              `<li><a href="/post/${post.id}">${escapeHtml(post.title)}</a></li>`,
          )
          .join("")
      : "<li>No posts available for this conference.</li>";

  const locationHtml = conference.location_address
    ? `<p><strong>Location:</strong> ${escapeHtml(conference.location_address)}</p>`
    : "";

  const dateHtml = `<p><strong>Dates:</strong> ${formatDateRange(conference.start_time, conference.stop_time)}</p>`;

  return `
    <div class="site-page">
      <h2>${escapeHtml(conference.name)}</h2>
      ${locationHtml}
      ${dateHtml}
      ${renderTagChips(tags)}
      <p>${escapeHtml(conference.description || "")}</p>
      <ul>
        ${postsHtml}
      </ul>
    </div>
  `;
}

export async function handleFeaturedConferences(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const conferences = await getFeaturedConferences(env);
    const html = renderFeaturedConferences(conferences);

    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=300", // Cache for 5 minutes
      },
    });
  } catch (error) {
    console.error("Error fetching featured conferences:", error);
    return new Response(
      "<p>Error loading featured conferences. Please try again later.</p>",
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      },
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
      return new Response(
        renderFullPage(
          "Error",
          "<h2>Error</h2><p>Conference slug is required</p>",
        ),
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        },
      );
    }

    const conference = await getConferenceBySlug(env, decodeURIComponent(slug));
    if (!conference) {
      return new Response(
        renderFullPage(
          "Conference Not Found",
          "<h2>Conference Not Found</h2><p>The requested conference could not be found.</p>",
        ),
        {
          status: 404,
          headers: { "Content-Type": "text/html" },
        },
      );
    }

    const [posts, tags] = await Promise.all([
      getPostsByConferenceId(env, conference.id),
      getTagsForConference(env, conference.id),
    ]);
    const content = renderConferencePage(conference, posts, tags);
    const fullHtml = renderFullPage(conference.name, content);

    return new Response(fullHtml, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=300", // Cache for 5 minutes
      },
    });
  } catch (error) {
    console.error("Error fetching conference:", error);
    return new Response(
      renderFullPage(
        "Error",
        "<h2>Error</h2><p>Error loading conference. Please try again later.</p>",
      ),
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      },
    );
  }
}

async function getAllConferences(env: Env): Promise<Conference[]> {
  const stmt = env.DB.prepare(`
    SELECT id, name
    FROM conferences
    ORDER BY name ASC
  `);

  const result = await stmt.all();
  return result.results as unknown as Conference[];
}

export async function handleComponentCreateFormAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const user = await getSessionUser(request, env);

  if (!user) {
    return new Response("", {
      status: 200,
      headers: { "HX-Redirect": "/login" },
    });
  }

  const html = `<div id="auth-email-container"><label>Email</label><input type="email" name="email" value="${escapeHtml(user.email)}" readonly /></div>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "private, no-cache",
    },
  });
}

export async function handleComponentConferenceOptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const conferences = await getAllConferences(env);
    const optionsHtml = conferences
      .map(
        (conf) =>
          `<option value="${conf.id}">${escapeHtml(conf.name)}</option>`,
      )
      .join("");
    const html =
      optionsHtml + '<option value="new">Create New Conference</option>';

    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    console.error("Error fetching conferences:", error);
    return new Response(
      '<option value="new">Error loading conferences. Create New Conference.</option>',
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      },
    );
  }
}

/** Subject links in the nav, shared by base.njk and renderFullPage(). */
export async function handleComponentNavSubjects(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const tags = await getAllTags(env);
    const html = tags
      .map(
        (tag) =>
          `<a href="/subject/${encodeURIComponent(tag.slug)}" class="nav-subject">${escapeHtml(tag.name)}</a>`,
      )
      .join("");

    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error fetching nav subjects:", error);
    return new Response("", { headers: { "Content-Type": "text/html" } });
  }
}

/** `<option>` list for the subject filters and the create-post subject picker. */
export async function handleComponentTagOptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const includeBlank = url.searchParams.get("blank") !== "0";
  const selected = url.searchParams.get("selected") || "";

  try {
    const tags = await getAllTags(env);
    const blank = includeBlank ? '<option value="">Subject</option>' : "";
    const html =
      blank +
      tags
        .map(
          (tag) =>
            `<option value="${escapeHtml(tag.slug)}"${tag.slug === selected ? " selected" : ""}>${escapeHtml(tag.name)}</option>`,
        )
        .join("");

    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error fetching tag options:", error);
    return new Response('<option value="">Subject</option>', {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

/**
 * Slugs address /conference/:slug, so a collision would make the newer
 * conference unreachable. Suffix until free; a UNIQUE index backstops this.
 */
async function generateUniqueSlug(env: Env, name: string): Promise<string> {
  const base = generateSlug(name) || "conference";
  let slug = base;
  let suffix = 2;

  while (
    await env.DB.prepare(`SELECT 1 FROM conferences WHERE slug = ?`)
      .bind(slug)
      .first()
  ) {
    slug = `${base}-${suffix}`;
    suffix += 1;
    if (suffix > 100) {
      slug = `${base}-${Date.now()}`;
      break;
    }
  }

  return slug;
}

export async function handleCreatePost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const user = await getSessionUser(request, env);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

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

      const slug = await generateUniqueSlug(env, newConfName);
      const startTime = Math.floor(new Date(newConfStartStr).getTime() / 1000);
      const stopTime = Math.floor(new Date(newConfEndStr).getTime() / 1000);

      if (!Number.isFinite(startTime) || !Number.isFinite(stopTime)) {
        return new Response("Invalid conference dates", { status: 400 });
      }

      const result = await env.DB.prepare(
        `
        INSERT INTO conferences (user_id, name, slug, location_address, start_time, stop_time, created_at, is_featured)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        RETURNING id
      `,
      )
        .bind(
          userId,
          newConfName,
          slug,
          newConfLocation || null,
          startTime,
          stopTime,
          now,
        )
        .first<{ id: number }>();

      if (!result) {
        throw new Error("Failed to create conference");
      }
      conferenceId = result.id.toString();

      // Subjects are conference-level. Only slugs already in `tags` are accepted,
      // so the curated list stays curated.
      const submittedTags = formData
        .getAll("conf_tags")
        .map((value) => String(value).trim())
        .filter(Boolean);

      if (submittedTags.length > 0) {
        const validTags = new Set((await getAllTags(env)).map((t) => t.slug));
        const inserts = submittedTags
          .filter((slug) => validTags.has(slug))
          .map((slug) =>
            env.DB.prepare(
              `INSERT OR IGNORE INTO conference_tags (tag_slug, conference_id) VALUES (?, ?)`,
            ).bind(slug, result.id),
          );
        if (inserts.length > 0) {
          await env.DB.batch(inserts);
        }
      }
    }

    const parsedConferenceId = parseInt(conferenceId, 10);
    if (!Number.isFinite(parsedConferenceId)) {
      return new Response("Invalid conference", { status: 400 });
    }

    const result = await env.DB.prepare(
      `
      INSERT INTO posts (user_id, conference_id, title, description, created_at)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `,
    )
      .bind(userId, parsedConferenceId, title, description, now)
      .first<{ id: number }>();

    if (!result) {
      throw new Error("Failed to create post");
    }

    return Response.redirect(`${new URL(request.url).origin}/my-posts`, 303);
  } catch (err: any) {
    console.error("Error creating post:", err);
    return new Response("Internal Server Error: " + err.message, {
      status: 500,
    });
  }
}

export async function handleMessageSend(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const user = await getSessionUser(request, env);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const formData = await request.formData();
    const postId = formData.get("post_id") as string;
    const content = formData.get("content") as string;

    if (!postId || !content) {
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

    const stmt = env.DB.prepare(`
      SELECT u.email, p.title
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `);

    const result = await stmt
      .bind(parseInt(postId, 10))
      .first<{ email: string; title: string }>();

    if (!result) {
      return new Response("Post not found", { status: 404 });
    }

    const success = await sendInquiryEmail(
      result.email,
      user.email,
      result.title,
      content,
      env,
    );

    if (!success) {
      throw new Error("Failed to send email");
    }

    // Keep a record of what was sent through the platform.
    await env.DB.prepare(
      `
      INSERT INTO message (post_id, sender_email, recipient_email, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
      .bind(
        parseInt(postId, 10),
        user.email,
        result.email,
        content,
        Math.floor(Date.now() / 1000),
      )
      .run();

    return Response.redirect(
      `${new URL(request.url).origin}/post/${postId}?sent=1`,
      303,
    );
  } catch (error) {
    console.error("Error sending message:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

export async function handlePostShell(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Fetch static `/post/index.html` from Cloudflare Pages Assets
  const assetUrl = new URL("/post/", request.url);
  const assetRequest = new Request(assetUrl, request);
  return env.ASSETS.fetch(assetRequest);
}

export async function handleComponentPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const postId = params?.id;
  if (!postId) {
    return new Response("Missing post ID", { status: 400 });
  }

  try {
    const stmt = env.DB.prepare(`
      SELECT p.id, p.title, p.description, p.user_id, p.conference_id,
             c.name as conference_name, c.slug as conference_slug
      FROM posts p
      JOIN conferences c ON p.conference_id = c.id
      WHERE p.id = ?
    `);

    const result = await stmt.bind(parseInt(postId, 10)).first<{
      id: number;
      title: string;
      description: string;
      user_id: number;
      conference_id: number;
      conference_name: string;
      conference_slug: string;
    }>();

    if (!result) {
      return new Response("<p>Post not found.</p>", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    }

    const user = await getSessionUser(request, env);
    const isAuthor = user !== null && sessionUserId(user) === result.user_id;

    const formHtml = user
      ? `
        <form action="/api/message/send" method="POST">
          <input type="hidden" name="post_id" value="${result.id}" />
          <label>Message</label>
          <textarea name="content" rows="5" required></textarea>
          <div class="cf-turnstile" data-sitekey="0x4AAAAAAByAHmDummOs9UGm"></div>
          <button type="submit">Send</button>
        </form>
    `
      : `
        <p>Please <a href="/login">log in</a> to send an inquiry.</p>
    `;

    const ownerActions = isAuthor
      ? `
        <p class="post-actions">
          <a href="/post/${result.id}/edit" class="nav-link">Edit</a>
          <a href="/post/${result.id}/delete" class="nav-link danger-link">Delete</a>
        </p>
      `
      : `
        <p class="post-actions">
          <a href="/post/${result.id}/report" class="report-link">Report this post</a>
        </p>
      `;

    const sent = new URL(request.url).searchParams.get("sent") === "1";
    const sentNotice = sent
      ? `<p class="form-notice">Your inquiry was sent. The post author has your email address and can reply directly.</p>`
      : "";

    const html = `
      ${sentNotice}
      <article>
        <h2>${escapeHtml(result.title)}</h2>
        <p>${escapeHtml(result.description)}</p>
        <p><strong>Conference:</strong> <a href="/conference/${encodeURIComponent(result.conference_slug)}">${escapeHtml(result.conference_name)}</a></p>
        ${ownerActions}
      </article>
      <section>
        <h3>Send an Inquiry</h3>
        ${formHtml}
      </section>
    `;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html",
        // Varies by viewer (author actions, logged-out prompt) — never shared.
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    console.error("Error fetching post:", error);
    return new Response("<p>Error loading post.</p>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

export async function handleComponentNavUser(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const user = await getSessionUser(request, env);

  const html = user
    ? `<a href="/my-posts" class="nav-link">My Posts</a> <a href="#" hx-post="/api/auth/logout" class="nav-link">Logout</a>`
    : `<a href="/login" class="nav-link">Login</a>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "private, no-cache",
    },
  });
}

export async function handleMyPosts(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  _params?: Record<string, string>,
): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.redirect(new URL("/login", request.url).href, 302);
  }

  try {
    const query = `
      SELECT
        posts.id,
        posts.title,
        posts.description,
        posts.created_at,
        conferences.name AS conference_name,
        conferences.slug AS conference_slug,
        conferences.start_time,
        conferences.stop_time
      FROM posts
      JOIN conferences ON posts.conference_id = conferences.id
      WHERE posts.user_id = ?
      ORDER BY posts.created_at DESC
    `;

    const { results } = await env.DB.prepare(query)
      .bind(sessionUserId(user))
      .all<{
        id: number;
        title: string;
        description: string;
        created_at: number;
        conference_name: string;
        conference_slug: string;
        start_time: number;
        stop_time: number;
      }>();

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

    return new Response(renderFullPage("My Posts", content), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-cache",
      },
    });
  } catch (error) {
    console.error("Error fetching my posts:", error);
    return new Response(
      renderFullPage(
        "Error",
        `<div class="site-page"><h2>Error</h2><p>Failed to load your posts. Please try again later.</p></div>`,
      ),
      {
        status: 500,
        headers: { "Content-Type": "text/html" },
      },
    );
  }
}

/** `%` and `_` are LIKE wildcards; a user typing them should match literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function handleSearch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const conference = url.searchParams.get("conference")?.trim() || "";
  const tag = url.searchParams.get("tag")?.trim() || "";
  const startParam = url.searchParams.get("start") || "";
  const endParam = url.searchParams.get("end") || "";

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (q) {
    conditions.push(
      `(posts.title LIKE ? ESCAPE '\\' OR posts.description LIKE ? ESCAPE '\\')`,
    );
    bindings.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`);
  }
  if (conference) {
    conditions.push(`conferences.name LIKE ? ESCAPE '\\'`);
    bindings.push(`%${escapeLike(conference)}%`);
  }
  if (tag) {
    conditions.push(
      `conferences.id IN (SELECT conference_id FROM conference_tags WHERE tag_slug = ?)`,
    );
    bindings.push(tag);
  }
  if (startParam) {
    const startTs = Math.floor(new Date(startParam).getTime() / 1000);
    if (Number.isFinite(startTs)) {
      conditions.push("conferences.stop_time >= ?");
      bindings.push(startTs);
    }
  }
  if (endParam) {
    const endTs = Math.floor(new Date(endParam).getTime() / 1000);
    if (Number.isFinite(endTs)) {
      conditions.push("conferences.start_time <= ?");
      bindings.push(endTs);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const searched = Boolean(q || conference || tag || startParam || endParam);

  let resultsHtml = "";

  try {
    const sql = `
      SELECT
        posts.id,
        posts.title,
        posts.description,
        conferences.name AS conference_name,
        conferences.slug AS conference_slug,
        conferences.location_address,
        conferences.start_time,
        conferences.stop_time
      FROM posts
      JOIN conferences ON posts.conference_id = conferences.id
      ${where}
      ORDER BY conferences.start_time ASC, posts.created_at DESC
      LIMIT 50
    `;

    const stmt = env.DB.prepare(sql);
    const bound = bindings.length > 0 ? stmt.bind(...bindings) : stmt;
    const { results } = await bound.all<{
      id: number;
      title: string;
      description: string;
      conference_name: string;
      conference_slug: string;
      location_address: string;
      start_time: number;
      stop_time: number;
    }>();

    if (results.length === 0) {
      resultsHtml = searched
        ? `<p>No posts found matching your search.</p>`
        : `<p>No posts yet. <a href="/create">Create the first one</a>.</p>`;
    } else {
      resultsHtml =
        `<p class="search-count">${results.length} post${results.length === 1 ? "" : "s"}${results.length === 50 ? " (showing the first 50)" : ""}</p>` +
        results
          .map(
            (post) => `
        <div class="post-card">
          <h3><a href="/post/${post.id}">${escapeHtml(post.title)}</a></h3>
          <p>${escapeHtml(post.description.slice(0, 160))}${post.description.length > 160 ? "…" : ""}</p>
          <small>
            <a href="/conference/${encodeURIComponent(post.conference_slug)}">${escapeHtml(post.conference_name)}</a>
            ${post.location_address ? `· ${escapeHtml(post.location_address)}` : ""}
            · ${formatDateRange(post.start_time, post.stop_time)}
          </small>
        </div>
      `,
          )
          .join("");
    }
  } catch (error) {
    console.error("Search error:", error);
    resultsHtml = `<p>Error performing search. Please try again later.</p>`;
  }

  const content = `
    <div class="site-page">
      <h2>Search Listings</h2>
      <form method="GET" action="/search" class="search-form">
        <input type="text" name="q" placeholder="Keywords in post title or description" value="${escapeHtml(q)}" />
        <input type="text" name="conference" placeholder="Conference name" value="${escapeHtml(conference)}" />
        <select name="tag"
                hx-get="/api/components/tag-options?selected=${encodeURIComponent(tag)}"
                hx-trigger="load"
                hx-swap="innerHTML">
          <option value="">Subject</option>
        </select>
        <input type="date" name="start" value="${escapeHtml(startParam)}" />
        <input type="date" name="end" value="${escapeHtml(endParam)}" />
        <button type="submit">Search</button>
      </form>
      <div id="results">
        ${resultsHtml}
      </div>
    </div>
  `;

  return new Response(renderFullPage("Search", content), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleSubjectPage(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const slug = params?.slug ? decodeURIComponent(params.slug) : "";

  const tag = await env.DB.prepare(`SELECT slug, name FROM tags WHERE slug = ?`)
    .bind(slug)
    .first<Tag>();

  if (!tag) {
    return new Response(
      renderFullPage(
        "Subject Not Found",
        `<div class="site-page"><h2>Subject Not Found</h2><p>No such subject. <a href="/search">Browse all posts</a> instead.</p></div>`,
      ),
      { status: 404, headers: { "Content-Type": "text/html" } },
    );
  }

  try {
    const { results } = await env.DB.prepare(
      `
      SELECT conferences.id, conferences.name, conferences.slug,
             conferences.location_address, conferences.start_time, conferences.stop_time,
             COUNT(posts.id) AS post_count
      FROM conferences
      JOIN conference_tags ON conference_tags.conference_id = conferences.id
      LEFT JOIN posts ON posts.conference_id = conferences.id
      WHERE conference_tags.tag_slug = ?
      GROUP BY conferences.id
      ORDER BY conferences.start_time ASC
    `,
    )
      .bind(slug)
      .all<Conference & { post_count: number }>();

    const listHtml =
      results.length > 0
        ? `<ul>${results
            .map(
              (conf) => `
          <li>
            <a href="/conference/${encodeURIComponent(conf.slug)}">
              <strong>${escapeHtml(conf.name)}</strong>
            </a><br />
            ${conf.location_address ? `${escapeHtml(conf.location_address)} · ` : ""}${formatDateRange(conf.start_time, conf.stop_time)}
            · ${conf.post_count} post${conf.post_count === 1 ? "" : "s"}
          </li>
        `,
            )
            .join("")}</ul>`
        : `<p class="empty-state">No conferences tagged ${escapeHtml(tag.name)} yet.</p>`;

    const content = `
      <div class="site-page">
        <h2>${escapeHtml(tag.name)} Conferences</h2>
        ${listHtml}
      </div>
    `;

    return new Response(renderFullPage(`${tag.name} Conferences`, content), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    console.error("Error loading subject page:", error);
    return new Response(
      renderFullPage(
        "Error",
        `<div class="site-page"><h2>Error</h2><p>Failed to load this subject. Please try again later.</p></div>`,
      ),
      { status: 500, headers: { "Content-Type": "text/html" } },
    );
  }
}
