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
