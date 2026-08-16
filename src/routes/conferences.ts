import { escapeHtml, formatDateRange } from "../lib/html";
import {
  errorPage,
  fragmentResponse,
  notFoundPage,
  pageResponse,
} from "../lib/response";
import {
  getConferenceBySlug,
  listAllConferences,
  listFeaturedConferences,
} from "../db/conferences";
import { listPostsForConference } from "../db/posts";
import { listTagsForConference, listTagsForConferences } from "../db/tags";
import type {
  Conference,
  ConferenceListing,
  ConferenceWithPostCount,
  Post,
  Tag,
} from "../db/types";

/**
 * Conference browsing: the `/conferences` index, the `/conference/:slug` page,
 * and the homepage's featured list fragment.
 *
 * The render helpers below stay private to this file on purpose. They are used
 * by exactly one handler each (and `renderTagChips` by exactly one other
 * helper), so hoisting them into a shared `render.ts` would buy nothing and
 * recreate `api.ts` at a smaller scale. `renderIndexItem()` is deliberately a
 * near-twin of the list item `/subject/:slug` renders — the same rule says a
 * two-line template shared by two pages is not worth a cross-module import.
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

/* ------------------------------------------- /conferences, grouped by subject */

/**
 * One heading and the conferences under it.
 *
 * `tag: null` is the trailing "no subject yet" group. It is not a subject and
 * does not link anywhere, which is why this is a nullable `Tag` rather than a
 * synthetic tag row with a made-up slug — a fake slug would render as a link to
 * a `/subject/:slug` that 404s.
 */
interface SubjectGroup {
  tag: Tag | null;
  conferences: ConferenceWithPostCount[];
}

/**
 * Buckets conferences under each subject they carry.
 *
 * Three decisions worth stating, because none of them is the only possible one:
 *
 *  - **A conference with two subjects appears under both.** Subjects are a
 *    many-to-many (`conference_tags`), so picking one bucket per conference
 *    would mean inventing a "primary" subject the data does not have, and would
 *    hide a joint bio/CS conference from one of the two audiences looking for it.
 *    The page is a browse index, not a count of conferences.
 *  - **Untagged conferences get their own group at the end, rather than being
 *    dropped.** On production almost nothing is tagged — subjects can only be
 *    set while creating a conference, so everything predating the feature is
 *    permanently untaggable — and a strict grouping would render an empty page
 *    on the live database. The group is last so it does not lead with the gap.
 *  - **Subjects with no conferences are omitted**, rather than rendered as
 *    twelve empty headings. The nav already lists every subject; this page shows
 *    what is actually there.
 *
 * Groups come out ordered by subject name, and conferences keep the order they
 * arrived in (`listAllConferences()` sorts them), so the ordering is a property
 * of the query rather than something re-decided here.
 */
function groupBySubject(
  conferences: ConferenceWithPostCount[],
  tagsByConference: Map<number, Tag[]>,
): SubjectGroup[] {
  const bySlug = new Map<string, SubjectGroup>();
  const untagged: ConferenceWithPostCount[] = [];

  for (const conference of conferences) {
    const tags = tagsByConference.get(conference.id) ?? [];
    if (tags.length === 0) {
      untagged.push(conference);
      continue;
    }
    for (const tag of tags) {
      const group = bySlug.get(tag.slug);
      if (group) group.conferences.push(conference);
      else bySlug.set(tag.slug, { tag, conferences: [conference] });
    }
  }

  const groups = [...bySlug.values()].sort((a, b) =>
    // Both tags are non-null in this map; only the untagged group below is not.
    (a.tag?.name ?? "").localeCompare(b.tag?.name ?? ""),
  );
  if (untagged.length > 0) groups.push({ tag: null, conferences: untagged });
  return groups;
}

function renderIndexItem(conference: ConferenceWithPostCount): string {
  return `
    <li>
      <a href="/conference/${encodeURIComponent(conference.slug)}">
        <strong>${escapeHtml(conference.name)}</strong>
      </a><br />
      ${conference.location_address ? `${escapeHtml(conference.location_address)} · ` : ""}${formatDateRange(conference.start_time, conference.stop_time)}
      · ${conference.post_count} post${conference.post_count === 1 ? "" : "s"}
    </li>
  `;
}

function renderSubjectGroup(group: SubjectGroup): string {
  const heading = group.tag
    ? `<h3><a href="/subject/${encodeURIComponent(group.tag.slug)}">${escapeHtml(group.tag.name)}</a></h3>`
    : `<h3>No subject yet</h3>
       <p class="empty-state">These conferences have not been assigned a subject.</p>`;

  return `
    <section class="subject-group">
      ${heading}
      <ul>${group.conferences.map(renderIndexItem).join("")}</ul>
    </section>
  `;
}

function renderAllConferences(
  groups: SubjectGroup[],
  total: number,
): string {
  if (total === 0) {
    return `
      <div class="site-page">
        <h2>All Conferences</h2>
        <p class="empty-state">No conferences have been added yet.</p>
      </div>
    `;
  }

  return `
    <div class="site-page">
      <h2>All Conferences</h2>
      <p>${total} conference${total === 1 ? "" : "s"}, grouped by subject. A conference listed under more than one subject appears in each.</p>
      ${groups.map(renderSubjectGroup).join("")}
    </div>
  `;
}

/**
 * `/conferences` — every conference, grouped by subject.
 *
 * Two queries regardless of size: the conferences, then all their subjects at
 * once. Reading subjects per conference would be a query per row, which is the
 * mistake `listShareTypesForPosts()` exists to prevent on the post lists.
 *
 * Nothing links here yet — deliberately, pending the redesign. It is registered,
 * reachable and indexable; it is just not in the nav.
 *
 * Conferences are ordered by start date ascending, matching `/subject/:slug`,
 * which means finished conferences sit at the top. That is the sibling page's
 * existing behaviour rather than a choice made here; if it should instead lead
 * with upcoming ones, the change belongs in `listAllConferences()` and
 * `listConferencesForTag()` together, so the two pages do not disagree.
 */
export async function handleAllConferences(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  try {
    const conferences = await listAllConferences(env);
    const tagsByConference = await listTagsForConferences(
      env,
      conferences.map((conference) => conference.id),
    );
    const content = renderAllConferences(
      groupBySubject(conferences, tagsByConference),
      conferences.length,
    );

    return pageResponse("All Conferences", content, {
      cache: "public-short",
      description:
        "Every conference on ResearchRoomies, grouped by field of study. Find academics attending the same conference and share travel costs.",
      canonicalUrl: `${new URL(request.url).origin}/conferences`,
    });
  } catch (error) {
    console.error("Error listing conferences:", error);
    return errorPage();
  }
}
