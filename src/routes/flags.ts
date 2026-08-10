import { sendReportEmail } from "../lib/mailgun";
import { getSessionUser } from "../lib/session";
import { turnstileWidget, verifyTurnstile } from "../lib/turnstile";
import { escapeHtml } from "../lib/html";
import { errorPage, notFoundPage, pageResponse } from "../lib/response";
import { parseRouteId } from "../lib/params";

interface ReportablePost {
  id: number;
  title: string;
  conference_name: string;
}

const REPORT_REASONS = [
  "Spam or advertising",
  "Scam or fraud",
  "Harassment or abuse",
  "Off-topic",
  "Other",
];

function renderReportForm(env: Env, post: ReportablePost): string {
  const optionsHtml = REPORT_REASONS.map(
    (reason) => `<option value="${escapeHtml(reason)}">${escapeHtml(reason)}</option>`,
  ).join("");

  return `
    <div class="site-page">
      <h1>Report Post</h1>
      <p>You are reporting: <strong>${escapeHtml(post.title)}</strong>${
        post.conference_name
          ? ` &middot; ${escapeHtml(post.conference_name)}`
          : ""
      }</p>
      <form method="POST" action="/post/${post.id}/report">
        <label for="reason">Reason</label>
        <select name="reason" id="reason" required>
          ${optionsHtml}
        </select>
        <label for="details">Additional details (optional)</label>
        <textarea name="details" id="details" rows="5"></textarea>
        ${turnstileWidget(env)}
        <button type="submit">Submit Report</button>
      </form>
    </div>
  `;
}

/** GET /post/:id/report */
export async function handleReportForm(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  // Authenticate BEFORE looking anything up. Querying first meant an anonymous
  // caller got a 302 for a post that exists and a 404 for one that does not,
  // turning this route into a membership oracle over the posts table. Every
  // other handler checks the session first; this one was inverted.
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.redirect(new URL("/login", request.url).href, 302);
  }

  const parsedPostId = parseRouteId(params?.id);
  if (parsedPostId === null) {
    // Deliberately 400 rather than notFoundPage()'s 404: posts.ts answers the
    // same condition with a 404 and the two should probably agree, but that is
    // a behaviour decision, not part of this response-plumbing change.
    return pageResponse(
      "Error",
      `<div class="site-page"><h2>Error</h2><p>Post ID is required.</p></div>`,
      { status: 400, cache: "none" },
    );
  }

  try {
    const post = await env.DB.prepare(
      `
      SELECT p.id, p.title, c.name AS conference_name
      FROM posts p
      JOIN conferences c ON p.conference_id = c.id
      WHERE p.id = ?
    `,
    )
      .bind(parsedPostId)
      .first<ReportablePost>();

    if (!post) {
      return notFoundPage("Post");
    }

    const content = renderReportForm(env, post);

    return pageResponse("Report Post", content);
  } catch (error) {
    console.error("Error loading report form:", error);
    return errorPage();
  }
}

/** POST /post/:id/report */
export async function handleReportSubmit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params?: Record<string, string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const user = await getSessionUser(request, env);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const parsedPostId = parseRouteId(params?.id);
  if (parsedPostId === null) {
    return new Response("Invalid post", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const reason = ((formData.get("reason") as string) || "").trim();
    const details = ((formData.get("details") as string) || "").trim();

    if (!reason) {
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

    const post = await env.DB.prepare(`SELECT id, title FROM posts WHERE id = ?`)
      .bind(parsedPostId)
      .first<{ id: number; title: string }>();

    if (!post) {
      return notFoundPage("Post");
    }

    const combinedReason = details ? `${reason}: ${details}` : reason;
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      `INSERT INTO flags (post_id, reason, flagged_by, timestamp) VALUES (?, ?, ?, ?)`,
    )
      .bind(parsedPostId, combinedReason, user.email, now)
      .run();

    // The DB row is the source of truth for moderation; email is a
    // best-effort notification and should never fail the report.
    const emailSent = await sendReportEmail(
      parsedPostId,
      post.title,
      combinedReason,
      user.email,
      env,
    );
    if (!emailSent) {
      console.error(
        `Failed to send report notification email for post ${parsedPostId}`,
      );
    }

    const content = `
      <div class="site-page">
        <h1>Report Received</h1>
        <p>Thanks &mdash; we've received your report. Our team will review it shortly.</p>
        <p><a href="/post/${post.id}">Back to post</a></p>
      </div>
    `;

    return pageResponse("Report Received", content, { cache: "none" });
  } catch (error) {
    console.error("Error submitting report:", error);
    return errorPage();
  }
}
