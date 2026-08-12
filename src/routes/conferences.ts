import { escapeHtml, formatDateRange } from "../lib/html";
import {
  errorPage,
  fragmentResponse,
  notFoundPage,
  pageResponse,
} from "../lib/response";
import {
  getConferenceBySlug,
  listFeaturedConferences,
} from "../db/conferences";
import { listPostsForConference } from "../db/posts";
import { listTagsForConference } from "../db/tags";
import type { Conference, ConferenceListing, Post, Tag } from "../db/types";

/**
 * Conference browsing: the `/conference/:slug` page and the homepage's featured
 * list fragment.
 *
 * The three render helpers below stay private to this file on purpose. They are
 * used by exactly one handler each (and `renderTagChips` by exactly one other
 * helper), so hoisting them into a shared `render.ts` would buy nothing and
 * recreate `api.ts` at a smaller scale.
 */

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
