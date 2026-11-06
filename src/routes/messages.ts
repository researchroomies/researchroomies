import { sendInquiryEmail } from "../lib/mailgun";
import { requireUser } from "../lib/guards";
import { verifyTurnstile } from "../lib/turnstile";
import { parseRouteId } from "../lib/params";
import { errorPage, pageResponse } from "../lib/response";
import { getPostAuthorContact } from "../db/posts";
import { hasRecentMessage, settleMessage, startMessage } from "../db/messages";
import { ARCHIVED_NOTICE, isArchived } from "../lib/archive";

/**
 * How far back an identical inquiry counts as the same one.
 *
 * Long enough to cover someone retrying after an error page or a dropped
 * connection. Short enough that deliberately re-sending the same words later,
 * after getting no reply, still goes through.
 */
export const INQUIRY_DEDUPE_SECONDS = 10 * 60;

/**
 * `POST /api/message/send`, the inquiry form on a post page.
 *
 * The order is what this handler is about, so it is spelled out:
 *
 *   1. Record the inquiry as 'pending'. If D1 fails here nothing has been sent,
 *      so an error page with "try again" is honest.
 *   2. Send it.
 *   3. Settle the row. Once Mailgun has accepted the email the user is told it
 *      was sent, whatever happens next: a failure to settle is logged and the
 *      row stays 'pending', which `hasRecentMessage()` already treats as sent.
 *      The one thing this must never do is show an error for an email that has
 *      gone out, because that is what made people retry and the author receive
 *      it twice.
 *
 * Before step 1, an identical inquiry from the same sender in the last
 * `INQUIRY_DEDUPE_SECONDS` short-circuits to the success page without sending.
 * That catches the retry after a lost response, and a 'pending' row left by a
 * Worker that died mid-send.
 */
export async function handleMessageSend(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const guard = await requireUser(request, env, "api");
  if (!guard.ok) return guard.response;
  const user = guard.value;

  try {
    const formData = await request.formData();
    const postId = parseRouteId(formData.get("post_id") as string | null);
    const content = formData.get("content") as string;

    if (postId === null || !content) {
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

    const recipient = await getPostAuthorContact(env, postId);

    if (!recipient) {
      return new Response("Post not found", { status: 404 });
    }

    // The post page hides this form once the conference is over, so reaching
    // here means a stale page or a hand-made POST. Checked against the row the
    // address came from rather than against anything the form said.
    if (isArchived(recipient)) {
      return new Response(ARCHIVED_NOTICE, { status: 403 });
    }

    const sentUrl = `${new URL(request.url).origin}/post/${postId}?sent=1`;
    const now = Math.floor(Date.now() / 1000);

    if (
      await hasRecentMessage(env, {
        postId,
        senderEmail: user.email,
        content,
        since: now - INQUIRY_DEDUPE_SECONDS,
      })
    ) {
      return Response.redirect(sentUrl, 303);
    }

    const messageId = await startMessage(env, {
      postId,
      senderEmail: user.email,
      recipientEmail: recipient.email,
      content,
      timestamp: now,
    });

    const sent = await sendInquiryEmail(
      recipient.email,
      user.email,
      recipient.title,
      content,
      env,
    );

    if (!sent) {
      await settleQuietly(env, messageId, "failed");
      return notSentPage(postId);
    }

    await settleQuietly(env, messageId, "sent");
    return Response.redirect(sentUrl, 303);
  } catch (error) {
    // Only reachable before the send: everything after it is caught by
    // settleQuietly(). So this page may truthfully say nothing went out.
    console.error("Error sending message:", error);
    return errorPage();
  }
}

/** Settles the row, and never throws: the outcome the user sees is already decided. */
async function settleQuietly(
  env: Env,
  id: number,
  status: "sent" | "failed",
): Promise<void> {
  try {
    await settleMessage(env, id, status);
  } catch (error) {
    console.error(`Failed to mark message ${id} as ${status}:`, error);
  }
}

/**
 * The mail provider refused or could not be reached. 502, as `handleAuthStart`
 * answers the same failure, and a page rather than bare text because this is a
 * plain form POST that lands in the address bar.
 */
function notSentPage(postId: number): Response {
  return pageResponse(
    "Inquiry not sent",
    `<div class="site-page">
        <h1>Your inquiry was not sent</h1>
        <p>We could not deliver your message just now. Nothing was sent, so it is safe to try again in a few minutes.</p>
        <p><a href="/post/${postId}" class="btn btn-secondary">Back to post</a></p>
      </div>`,
    { status: 502, cache: "none" },
  );
}
