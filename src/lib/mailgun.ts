import { formatTtlMinutes, getConfig, type AppConfig } from "./config";

interface MailgunMessage {
    to: string;
    subject: string;
    text: string;
    html: string;
    /** Local part of the From address when MAILGUN_SENDING_KEY is unset. */
    fromLocalPart: string;
    replyTo?: string;
}

/**
 * MAILGUN_SENDING_KEY is not a key — it is the From address, given either as a
 * bare local part ("login") or in full ("login@example.com"). Misleading name
 * kept for now because it is already set as a deployed secret; `config.ts`
 * normalizes it to a full address, or to null when it is unset.
 */
function resolveFromAddress(config: AppConfig, fromLocalPart: string): string {
    return config.mailgun.from ?? `${fromLocalPart}@${config.mailgun.domain}`;
}

async function sendMailgunMessage(message: MailgunMessage, env: Env): Promise<boolean> {
    const config = getConfig(env);
    const formData = new FormData();
    formData.append("from", `Research Roomies <${resolveFromAddress(config, message.fromLocalPart)}>`);
    formData.append("to", message.to);
    if (message.replyTo) {
        formData.append("h:Reply-To", message.replyTo);
    }
    formData.append("subject", message.subject);
    formData.append("text", message.text);
    formData.append("html", message.html);

    const auth = btoa(`api:${env.MAILGUN_API_KEY}`);

    try {
        const resp = await fetch(`${config.mailgun.apiBase}/${config.mailgun.domain}/messages`, {
            method: "POST",
            headers: {
                Authorization: `Basic ${auth}`,
            },
            body: formData,
        });

        if (!resp.ok) {
            console.error(`Mailgun error ${resp.status} ${resp.statusText}:`, await resp.text());
            return false;
        }

        return true;
    } catch (e) {
        console.error("Mailgun exception:", e);
        return false;
    }
}

export async function sendMagicLink(
    email: string,
    link: string,
    env: Env
): Promise<boolean> {
    // Read from the same constant the token's `exp` is built from, so the copy
    // cannot promise a lifetime the link does not have.
    const validFor = formatTtlMinutes(getConfig(env).magicLinkTtlSeconds);

    return sendMailgunMessage({
        fromLocalPart: "login",
        to: email,
        subject: "Log in to Research Roomies",
        text: `Welcome to Research Roomies!

Click the link below to finish logging in:
${link}

This link is valid for ${validFor}.
`,
        html: `<html>
  <body>
    <h3>Welcome to Research Roomies!</h3>
    <p>Click the link below to finish logging in:</p>
    <p><a href="${link}">${link}</a></p>
    <p>This link is valid for ${validFor}.</p>
  </body>
</html>`,
    }, env);
}

function escapeHtmlForEmail(value: unknown): string {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export async function sendReportEmail(
    postId: number,
    postTitle: string,
    reason: string,
    reporterEmail: string,
    env: Env
): Promise<boolean> {
    // No request in hand here, so `origin` resolves to APP_ORIGIN or the
    // production default — the same absolute link this always produced.
    const config = getConfig(env);
    const postUrl = `${config.origin}/post/${postId}`;

    return sendMailgunMessage({
        fromLocalPart: "noreply",
        to: config.adminEmail,
        subject: `Post reported: ${postTitle}`,
        text: `A post has been reported on Research Roomies.\n\nPost: ${postTitle} (#${postId})\nLink: ${postUrl}\nReason: ${reason}\nReported by: ${reporterEmail}\n`,
        html: `<html>
  <body>
    <h3>Post Reported</h3>
    <p><strong>Post:</strong> ${escapeHtmlForEmail(postTitle)} (#${postId})</p>
    <p><strong>Link:</strong> <a href="${postUrl}">${postUrl}</a></p>
    <p><strong>Reason:</strong> ${escapeHtmlForEmail(reason)}</p>
    <p><strong>Reported by:</strong> ${escapeHtmlForEmail(reporterEmail)}</p>
  </body>
</html>`,
    }, env);
}

export async function sendInquiryEmail(
    authorEmail: string,
    senderEmail: string,
    postTitle: string,
    messageContent: string,
    env: Env
): Promise<boolean> {
    return sendMailgunMessage({
        fromLocalPart: "noreply",
        to: authorEmail,
        replyTo: senderEmail,
        subject: `New Inquiry for your post: ${postTitle}`,
        text: `You have received a new inquiry from ${senderEmail} regarding your post "${postTitle}".\n\nMessage:\n${messageContent}\n\nYou can reply directly to this email to respond to the sender.\n`,
        html: `<html>
  <body>
    <h3>New Inquiry for "${escapeHtmlForEmail(postTitle)}"</h3>
    <p>You have received a new inquiry from <strong>${escapeHtmlForEmail(senderEmail)}</strong>.</p>
    <hr />
    <p style="white-space: pre-wrap;">${escapeHtmlForEmail(messageContent)}</p>
    <hr />
    <p><small>You can reply directly to this email to respond to the sender.</small></p>
  </body>
</html>`,
    }, env);
}
