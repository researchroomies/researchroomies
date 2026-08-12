import { sendReportEmail } from "../lib/mailgun";
import { turnstileWidget, verifyTurnstile } from "../lib/turnstile";
import { escapeHtml } from "../lib/html";
import { errorPage, notFoundPage, pageResponse } from "../lib/response";
import { parseRouteId } from "../lib/params";
import { requireUser } from "../lib/guards";
import { getPost, getPostWithConference } from "../db/posts";
import { recordFlag } from "../db/moderation";
import type { PostDetail } from "../db/types";

const REPORT_REASONS = [
  "Spam or advertising",
  "Scam or fraud",
  "Harassment or abuse",
  "Off-topic",
  "Other",
];

function renderReportForm(env: Env, post: PostDetail): string {
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
  const guard = await requireUser(request, env, "page");
  if (!guard.ok) return guard.response;

  // 404, not the 400 this used to answer with. A malformed id and a missing
  // post are the same thing to the caller — an id that names nothing — and
  // posts.ts already said 404. One answer now, from both files.
  const parsedPostId = parseRouteId(params?.id);
  if (parsedPostId === null) {
    return notFoundPage("Post");
  }

  try {
    const post = await getPostWithConference(env, parsedPostId);

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

  const guard = await requireUser(request, env, "api");
  if (!guard.ok) return guard.response;
  const user = guard.value;

  // 404 for the same reason as the GET above; this is the site that used to
  // answer 400 in bare text while posts.ts rendered a 404 page.
  const parsedPostId = parseRouteId(params?.id);
  if (parsedPostId === null) {
    return notFoundPage("Post");
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

    const post = await getPost(env, parsedPostId);

    if (!post) {
      return notFoundPage("Post");
    }

    const combinedReason = details ? `${reason}: ${details}` : reason;

    await recordFlag(env, {
      postId: parsedPostId,
      reason: combinedReason,
      flaggedBy: user.email,
      timestamp: Math.floor(Date.now() / 1000),
    });

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
