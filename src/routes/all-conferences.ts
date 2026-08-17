import { escapeHtml, formatDateRange } from "../lib/html";
import { errorPage, pageResponse } from "../lib/response";
import { listAllConferences } from "../db/conferences";
import { listTagsForConferences } from "../db/tags";
import type { ConferenceWithPostCount, Tag } from "../db/types";

/**
 * `GET /conferences` — every conference in the database, grouped by subject.
 *
 * Split out of conferences.ts during the redesign, for the reason that file's
 * own note predicted: it sat seven lines under `test/route-modules.test.ts`'s
 * 320-line bound, and the restyle was the next thing added to it. The seam is
 * the one that note named — the index and its grouping out to their own module,
 * leaving `/conference/:slug` and the featured fragment behind — rather than
 * raising the number.
 *
 * Nothing linked here before; the redesigned nav now does.
 */

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

/** The fragment identifier a group's heading and its jump chip agree on. */
function groupAnchor(group: SubjectGroup): string {
  return group.tag ? `subject-${encodeURIComponent(group.tag.slug)}` : "untagged";
}

function renderIndexItem(conference: ConferenceWithPostCount): string {
  const posts =
    conference.post_count === 0
      ? `<span>No posts yet</span>`
      : `<span class="count-open">${conference.post_count} post${conference.post_count === 1 ? "" : "s"}</span>`;

  return `
      <li>
        <a href="/conference/${encodeURIComponent(conference.slug)}">${escapeHtml(conference.name)}</a>
        <div class="card-meta">
          ${conference.location_address ? `<span>${escapeHtml(conference.location_address)}</span>` : ""}
          <span class="tnum">${formatDateRange(conference.start_time, conference.stop_time)}</span>
          ${posts}
        </div>
      </li>
    `;
}

/**
 * The jump row at the top: one chip per group, in the order the groups appear.
 *
 * They are in-page anchors rather than links to `/subject/:slug` because this
 * page already holds every conference — sending the reader to a second page to
 * see a subset of what is under their thumb is a worse answer. The group
 * headings still link out to the subject pages.
 */
function renderJumpChips(groups: SubjectGroup[]): string {
  if (groups.length === 0) return "";

  const chips = groups
    .map(
      (group) =>
        `<a class="tag tag-outline" href="#${groupAnchor(group)}">${escapeHtml(group.tag ? group.tag.name : "No subject yet")} ${group.conferences.length}</a>`,
    )
    .join("");

  return `<div class="jump-chips">${chips}</div>`;
}

function renderSubjectGroup(group: SubjectGroup): string {
  const heading = group.tag
    ? `<h2><a href="/subject/${encodeURIComponent(group.tag.slug)}">${escapeHtml(group.tag.name)}</a></h2>`
    : `<h2>No subject yet</h2>`;

  const note = group.tag
    ? ""
    : `<p class="field-hint">These conferences have not been assigned a subject.</p>`;

  const count = group.conferences.length;

  return `
      <section class="subject-group" id="${groupAnchor(group)}">
        <div class="subject-group-head">
          ${heading}
          <span class="subject-group-count">${count} conference${count === 1 ? "" : "s"}</span>
        </div>
        ${note}
        <ul class="conference-index">${group.conferences.map(renderIndexItem).join("")}</ul>
      </section>
    `;
}

function renderAllConferences(groups: SubjectGroup[], total: number): string {
  if (total === 0) {
    return `
      <div class="page-head">
        <div><h1 class="page-title">All conferences</h1></div>
      </div>
      <p class="empty-state">No conferences have been added yet. <a href="/create">Add the first one</a> while creating a post.</p>
    `;
  }

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">All conferences</h1>
        <p class="page-lede">${total} conference${total === 1 ? "" : "s"}, grouped by subject. A conference listed under more than one subject appears in each.</p>
      </div>
    </div>
    ${renderJumpChips(groups)}
    ${groups.map(renderSubjectGroup).join("")}
  `;
}

/**
 * `/conferences` — every conference, grouped by subject.
 *
 * Two queries regardless of size: the conferences, then all their subjects at
 * once. Reading subjects per conference would be a query per row, which is the
 * mistake `listShareTypesForPosts()` exists to prevent on the post lists.
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

    return pageResponse("All conferences", content, {
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
