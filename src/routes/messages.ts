import { sendInquiryEmail } from "../lib/mailgun";
import { requireUser } from "../lib/guards";
import { verifyTurnstile } from "../lib/turnstile";
import { parseRouteId } from "../lib/params";
import { getPostAuthorContact } from "../db/posts";
import { recordMessage } from "../db/moderation";

/**
 * `POST /api/message/send` — the inquiry form on a post page.
 *
 * KNOWN LIMIT: the `message` row is written only after Mailgun accepts, so a
 * Mailgun outage returns 500 and records nothing. That is deliberate for now —
 * a row here means "this was actually sent" — but it does mean the audit trail
 * has the same availability as the mail provider.
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

    const success = await sendInquiryEmail(
      recipient.email,
      user.email,
      recipient.title,
      content,
      env,
    );

    if (!success) {
      throw new Error("Failed to send email");
    }

    // Keep a record of what was sent through the platform.
    await recordMessage(env, {
      postId,
      senderEmail: user.email,
      recipientEmail: recipient.email,
      content,
      timestamp: Math.floor(Date.now() / 1000),
    });

    return Response.redirect(
      `${new URL(request.url).origin}/post/${postId}?sent=1`,
      303,
    );
  } catch (error) {
    console.error("Error sending message:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
