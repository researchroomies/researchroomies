import { optionalUser, requireUser } from "../lib/guards";
import { escapeHtml } from "../lib/html";
import { fragmentResponse } from "../lib/response";
import { listConferences } from "../db/conferences";
import { listTags } from "../db/tags";

/**
 * `/api/components/*` — HTMX fragments: raw HTML, never JSON, never a full page.
 *
 * These are the small pieces the static Eleventy pages and the Worker-rendered
 * shell fill in after load. The cache argument is the thing to get right in this
 * file: a fragment that varies by session must stay `private` (the default),
 * and only the genuinely shared lists opt into `public-*`.
 *
 * `/api/components/post/:id` is the one component route that is NOT here — it
 * shares `renderPostDetail()` with the `/post/:id` page and lives beside it in
 * post-detail.ts, because a route module must not import another route module.
 */

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
