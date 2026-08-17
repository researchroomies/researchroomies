import { escapeHtml, formatDateRange, summarize } from "../lib/html";
import { pageResponse } from "../lib/response";
import { searchPosts, SEARCH_LIMIT } from "../db/posts";
import { listShareTypes, listShareTypesForPosts } from "../db/share-types";
import { listTags } from "../db/tags";
import { shareTypeBadges, shareTypeOptions } from "../lib/share-types";
import type { ShareType, Tag } from "../db/types";

/**
 * `/search` — the post search page.
 *
 * The dynamic WHERE builder this handler used to carry inline lives in
 * `searchPosts()` (src/db/posts.ts). What is left here is parameter parsing and
 * rendering, plus one rule worth stating: a filter that cannot be parsed is
 * dropped rather than made fatal, so a hand-edited URL still returns results.
 */

/** Every filter this page reads, in the order the form lays them out. */
interface Filters {
  q: string;
  conference: string;
  tag: string;
  share: string;
  start: string;
  end: string;
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

/**
 * The active-filter chips.
 *
 * Each one's "×" is a link back to `/search` with that single parameter
 * dropped — the whole state of this page lives in the query string, so removing
 * a filter needs no script and no new endpoint. Slugs are shown by their display
 * name where one is known (`tag`, `share`), because "cs" is not what the reader
 * chose from the dropdown.
 */
function renderChips(
  filters: Filters,
  tags: Tag[],
  shareTypes: ShareType[],
): string {
  const nameFor = (list: { slug: string; name: string }[], slug: string) =>
    list.find((entry) => entry.slug === slug)?.name ?? slug;

  const active: [keyof Filters, string][] = [
    ["q", filters.q],
    ["conference", filters.conference],
    ["tag", filters.tag ? nameFor(tags, filters.tag) : ""],
    ["share", filters.share ? nameFor(shareTypes, filters.share) : ""],
    ["start", filters.start ? `From ${filters.start}` : ""],
    ["end", filters.end ? `To ${filters.end}` : ""],
  ];

  const chips = active
    .filter(([, label]) => label !== "")
    .map(([key, label]) => {
      const remaining = new URLSearchParams();
      for (const [name, value] of Object.entries(filters)) {
        if (name !== key && value) remaining.set(name, value);
      }
      const href = remaining.toString()
        ? `/search?${remaining.toString()}`
        : "/search";
      return `<a class="tag tag-outline" href="${escapeHtml(href)}">${escapeHtml(label)} ×</a>`;
    })
    .join("");

  return chips ? `<div class="filter-chips">${chips}</div>` : "";
}

function renderForm(
  filters: Filters,
  tags: Tag[],
  shareTypeList: ShareType[],
): string {
  const tagOptions = tags
    .map(
      (tag) =>
        `<option value="${escapeHtml(tag.slug)}"${tag.slug === filters.tag ? " selected" : ""}>${escapeHtml(tag.name)}</option>`,
    )
    .join("");

  return `
      <form method="GET" action="/search" class="search-form">
        <div class="field">
          <label for="search-q">Keywords</label>
          <input class="input" id="search-q" type="text" name="q" placeholder="Room share, ride from Boston" value="${escapeHtml(filters.q)}" />
        </div>
        <div class="field">
          <label for="search-conference">Conference</label>
          <input class="input" id="search-conference" type="text" name="conference" placeholder="Any" value="${escapeHtml(filters.conference)}" />
        </div>
        <div class="field">
          <label for="search-tag">Subject</label>
          <select class="input" id="search-tag" name="tag">
            <option value="">Any subject</option>
            ${tagOptions}
          </select>
        </div>
        <div class="field">
          <label for="search-share">Sharing</label>
          <select class="input" id="search-share" name="share">
            <option value="">Sharing anything</option>
            ${shareTypeOptions(shareTypeList, filters.share)}
          </select>
        </div>
        <div class="field">
          <label for="search-start">From</label>
          <input class="input" id="search-start" type="date" name="start" value="${escapeHtml(filters.start)}" />
        </div>
        <div class="field">
          <label for="search-end">To</label>
          <input class="input" id="search-end" type="date" name="end" value="${escapeHtml(filters.end)}" />
        </div>
        <button class="btn btn-primary" type="submit">Search</button>
      </form>`;
}

export async function handleSearch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const read = (name: string) => url.searchParams.get(name)?.trim() || "";
  const filters: Filters = {
    q: read("q"),
    conference: read("conference"),
    tag: read("tag"),
    share: read("share"),
    // The raw strings are kept to echo back into the form inputs; the parsed
    // timestamps are what the query filters on.
    start: read("start"),
    end: read("end"),
  };

  const searched = Object.values(filters).some(Boolean);

  // Server-rendered rather than fetched over HTMX: this page is already
  // Worker-rendered, so both lists are one more await instead of two round
  // trips — and the chips need the display names anyway, which the fragment
  // never handed back. A failure leaves the dropdowns with only their "any"
  // option, which is a weaker page but still a working search.
  let shareTypeList: ShareType[] = [];
  let tags: Tag[] = [];
  try {
    [shareTypeList, tags] = await Promise.all([
      listShareTypes(env),
      listTags(env),
    ]);
  } catch (error) {
    console.error("Error loading search filters:", error);
  }

  let resultsHtml = "";

  try {
    const results = await searchPosts(env, {
      q: filters.q,
      conference: filters.conference,
      tag: filters.tag,
      share: filters.share,
      overlapsFrom: dateParamToTimestamp(filters.start),
      overlapsUntil: dateParamToTimestamp(filters.end),
    });
    // One query for the page's badges rather than one per card.
    const shareTypes = await listShareTypesForPosts(
      env,
      results.map((post) => post.id),
    );

    if (results.length === 0) {
      resultsHtml = searched
        ? `<p class="empty-state">No posts found matching your search.</p>`
        : `<p class="empty-state">No posts yet. <a href="/create">Create the first one</a>.</p>`;
    } else {
      const cap =
        results.length === SEARCH_LIMIT
          ? ` (showing the first ${SEARCH_LIMIT})`
          : "";

      resultsHtml =
        `<div class="search-summary">
          <p class="search-count">${results.length} post${results.length === 1 ? "" : "s"}${cap}</p>
          ${renderChips(filters, tags, shareTypeList)}
          ${searched ? `<a class="clear-filters" href="/search">Clear filters</a>` : ""}
        </div>
        <div class="listing">` +
        results
          .map(
            (post) => `
          <article class="listing-item">
            <h3 class="listing-title"><a href="/post/${post.id}">${escapeHtml(post.title)}</a></h3>
            ${shareTypeBadges(shareTypes.get(post.id) ?? [])}
            <p class="listing-excerpt">${escapeHtml(summarize(post.description, 180))}</p>
            <div class="listing-meta">
              <a href="/conference/${encodeURIComponent(post.conference_slug)}">${escapeHtml(post.conference_name)}</a>
              ${post.location_address ? `<span>${escapeHtml(post.location_address)}</span>` : ""}
              <span class="tnum">${formatDateRange(post.start_time, post.stop_time)}</span>
            </div>
          </article>
        `,
          )
          .join("") +
        (cap
          ? `<p class="listing-note">Showing the first ${SEARCH_LIMIT} matches. Narrow the dates to see fewer.</p>`
          : "") +
        `</div>`;
    }
  } catch (error) {
    console.error("Search error:", error);
    resultsHtml = `<p class="empty-state">Error performing search. Please try again later.</p>`;
  }

  const content = `
    <div class="page-head">
      <div>
        <h1 class="page-title">Search posts</h1>
        <p class="page-lede">Filter by keyword, conference, subject, what's being shared, or the dates you'll be in town.</p>
      </div>
    </div>
    ${renderForm(filters, tags, shareTypeList)}
    <div id="results">
      ${resultsHtml}
    </div>
  `;

  return pageResponse("Search", content, { cache: "none" });
}
