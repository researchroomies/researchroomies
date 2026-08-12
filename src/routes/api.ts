import { sendInquiryEmail } from "../lib/mailgun";
import { sessionUserId } from "../lib/session";
import { optionalUser, requireUser } from "../lib/guards";
import { turnstileWidget, verifyTurnstile } from "../lib/turnstile";
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
import {
  createConference,
  getConferenceBySlug,
  listConferences,
  listFeaturedConferences,
  reserveSlug,
} from "../db/conferences";
import {
  createPost,
  getPostAuthorContact,
  getPostWithConference,
  listPostsForConference,
  listPostsForUser,
  searchPosts,
  SEARCH_LIMIT,
} from "../db/posts";
import { recordMessage } from "../db/moderation";
import {
  getTag,
  listConferencesForTag,
  listTags,
  listTagsForConference,
  tagConference,
} from "../db/tags";
import type {
  Conference,
  ConferenceListing,
  Post,
  PostDetail,
  Tag,
} from "../db/types";

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

function renderFeaturedConferences(conferences: ConferenceListing[]): string {
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
    const conferences = await listFeaturedConferences(env);
    const html = renderFeaturedConferences(conferences);

    return fragmentResponse(html, { cache: "public-short" });
  } catch (error) {
    console.error("Error fetching featured conferences:", error);
    return fragmentResponse(
      "<p>Error loading featured conferences. Please try again later.</p>",
      { status: 500, cache: "none" },
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
      // Kept as 400 rather than notFoundPage()'s 404: the route cannot match
      // without a slug segment, so this is an unreachable guard, not a miss.
      return pageResponse(
        "Error",
        `<div class="site-page"><h2>Error</h2><p>Conference slug is required</p></div>`,
        { status: 400, cache: "none" },
      );
    }

    const conference = await getConferenceBySlug(env, decodeURIComponent(slug));
    if (!conference) {
      return notFoundPage("Conference");
    }

    const [posts, tags] = await Promise.all([
      listPostsForConference(env, conference.id),
      listTagsForConference(env, conference.id),
    ]);
    const content = renderConferencePage(conference, posts, tags);

    return pageResponse(conference.name, content, { cache: "public-short" });
  } catch (error) {
    console.error("Error fetching conference:", error);
    return errorPage();
  }
}

export async function handleComponentCreateFormAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 'htmx': this is swapped into a live page, so the redirect has to travel as
  // a header on a 200 rather than as a 302 the fetch would follow invisibly.
  const guard = await requireUser(request, env, "htmx");
  if (!guard.ok) return guard.response;
  const user = guard.value;

  const html = `<div id="auth-email-container"><label>Email</label><input type="email" name="email" value="${escapeHtml(user.email)}" readonly /></div>`;
  // Contains the viewer's own email address — private is the default here.
  return fragmentResponse(html);
}

export async function handleComponentConferenceOptions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const conferences = await listConferences(env);
    const optionsHtml = conferences
      .map(
        (conf) =>
          `<option value="${conf.id}">${escapeHtml(conf.name)}</option>`,
      )
      .join("");
    const html =
      optionsHtml + '<option value="new">Create New Conference</option>';

    return fragmentResponse(html, { cache: "public-short" });
  } catch (error) {
    console.error("Error fetching conferences:", error);
    return fragmentResponse(
      '<option value="new">Error loading conferences. Create New Conference.</option>',
      { status: 500, cache: "none" },
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
    const tags = await listTags(env);
    const html = tags
      .map(
        (tag) =>
          `<a href="/subject/${encodeURIComponent(tag.slug)}" class="nav-subject">${escapeHtml(tag.name)}</a>`,
      )
      .join("");

    return fragmentResponse(html, { cache: "public-long" });
  } catch (error) {
    console.error("Error fetching nav subjects:", error);
    return fragmentResponse("", { cache: "none" });
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
    const tags = await listTags(env);
    const blank = includeBlank ? '<option value="">Subject</option>' : "";
    const html =
      blank +
      tags
        .map(
          (tag) =>
            `<option value="${escapeHtml(tag.slug)}"${tag.slug === selected ? " selected" : ""}>${escapeHtml(tag.name)}</option>`,
        )
        .join("");

    return fragmentResponse(html, { cache: "public-long" });
  } catch (error) {
    console.error("Error fetching tag options:", error);
    return fragmentResponse('<option value="">Subject</option>', {
      status: 500,
      cache: "none",
    });
  }
}

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

export async function handleMessageSend(
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
    const postId = parseRouteId(formData.get("post_id") as string | null);
    const content = formData.get("content") as string;

    if (postId === null || !content) {
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

    const recipient = await getPostAuthorContact(env, postId);

    if (!recipient) {
      return new Response("Post not found", { status: 404 });
    }

    const success = await sendInquiryEmail(
      recipient.email,
      user.email,
      recipient.title,
      content,
      env,
    );

    if (!success) {
      throw new Error("Failed to send email");
    }

    // Keep a record of what was sent through the platform.
    await recordMessage(env, {
      postId,
      senderEmail: user.email,
      recipientEmail: recipient.email,
      content,
      timestamp: Math.floor(Date.now() / 1000),
    });

    return Response.redirect(
      `${new URL(request.url).origin}/post/${postId}?sent=1`,
      303,
    );
  } catch (error) {
    console.error("Error sending message:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

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

export async function handleComponentNavUser(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const user = await optionalUser(request, env);

  const html = user
    ? `<a href="/my-posts" class="nav-link">My Posts</a> <a href="#" hx-post="/api/auth/logout" class="nav-link">Logout</a>`
    : `<a href="/login" class="nav-link">Login</a>`;

  // The whole point of this fragment is that it differs per session. It must
  // never be cached publicly — which is why 'private' is the default.
  return fragmentResponse(html);
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

/**
 * A `<input type="date">` value as Unix seconds, or null if it is absent or
 * unparseable. An unusable date drops its filter rather than failing the search.
 */
function dateParamToTimestamp(value: string): number | null {
  if (!value) return null;
  const seconds = Math.floor(new Date(value).getTime() / 1000);
  return Number.isFinite(seconds) ? seconds : null;
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
  // The raw strings are kept to echo back into the form inputs; the parsed
  // timestamps are what the query filters on.
  const startParam = url.searchParams.get("start") || "";
  const endParam = url.searchParams.get("end") || "";

  const searched = Boolean(q || conference || tag || startParam || endParam);

  let resultsHtml = "";

  try {
    const results = await searchPosts(env, {
      q,
      conference,
      tag,
      overlapsFrom: dateParamToTimestamp(startParam),
      overlapsUntil: dateParamToTimestamp(endParam),
    });

    if (results.length === 0) {
      resultsHtml = searched
        ? `<p>No posts found matching your search.</p>`
        : `<p>No posts yet. <a href="/create">Create the first one</a>.</p>`;
    } else {
      resultsHtml =
        `<p class="search-count">${results.length} post${results.length === 1 ? "" : "s"}${results.length === SEARCH_LIMIT ? ` (showing the first ${SEARCH_LIMIT})` : ""}</p>` +
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

  return pageResponse("Search", content, { cache: "none" });
}

export async function handleSubjectPage(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  const slug = params?.slug ? decodeURIComponent(params.slug) : "";

  try {
    // Inside the try: this is a DB call like any other, and when it was above
    // the block a D1 failure here escaped the handler as an unhandled 500
    // while the identical failure one query later rendered an error page.
    const tag = await getTag(env, slug);

    if (!tag) {
      return notFoundPage("Subject");
    }

    const results = await listConferencesForTag(env, slug);

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

    return pageResponse(`${tag.name} Conferences`, content, {
      cache: "public-short",
    });
  } catch (error) {
    console.error("Error loading subject page:", error);
    return errorPage();
  }
}
