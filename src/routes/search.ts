import { escapeHtml, formatDateRange } from "../lib/html";
import { pageResponse } from "../lib/response";
import { searchPosts, SEARCH_LIMIT } from "../db/posts";

/**
 * `/search` — the post search page.
 *
 * The dynamic WHERE builder this handler used to carry inline lives in
 * `searchPosts()` (src/db/posts.ts). What is left here is parameter parsing and
 * rendering, plus one rule worth stating: a filter that cannot be parsed is
 * dropped rather than made fatal, so a hand-edited URL still returns results.
 */

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
