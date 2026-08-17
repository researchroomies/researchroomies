import { escapeHtml, formatDateRange } from "../lib/html";
import { errorPage, notFoundPage, pageResponse } from "../lib/response";
import { getTag, listConferencesForTag } from "../db/tags";

/**
 * `/subject/:slug` — the conferences carrying one curated subject tag.
 *
 * Subjects are conference-level, not post-level, which is why this lists
 * conferences rather than posts. The curated list itself is enforced in
 * src/db/tags.ts.
 */
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
        ? `<ul class="conference-index">${results
            .map(
              (conf) => `
          <li>
            <a href="/conference/${encodeURIComponent(conf.slug)}">${escapeHtml(conf.name)}</a>
            <div class="card-meta">
              ${conf.location_address ? `<span>${escapeHtml(conf.location_address)}</span>` : ""}
              <span class="tnum">${formatDateRange(conf.start_time, conf.stop_time)}</span>
              ${
                conf.post_count === 0
                  ? `<span>No posts yet</span>`
                  : `<span class="count-open">${conf.post_count} post${conf.post_count === 1 ? "" : "s"}</span>`
              }
            </div>
          </li>
        `,
            )
            .join("")}</ul>`
        : `<p class="empty-state">No conferences tagged ${escapeHtml(tag.name)} yet.</p>`;

    const content = `
      <p class="breadcrumb"><a href="/conferences">Conferences</a> &nbsp;/&nbsp; ${escapeHtml(tag.name)}</p>
      <div class="page-head">
        <div>
          <h1 class="page-title">${escapeHtml(tag.name)}</h1>
          <p class="page-lede">${results.length} conference${results.length === 1 ? "" : "s"} in this subject. <a href="/conferences">See every subject</a>.</p>
        </div>
      </div>
      ${listHtml}
    `;

    return pageResponse(`${tag.name} Conferences`, content, {
      cache: "public-short",
    });
  } catch (error) {
    console.error("Error loading subject page:", error);
    return errorPage();
  }
}
