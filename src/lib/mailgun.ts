const MAILGUN_DOMAIN = "researchroomies.com";
// Region-specific. EU-region domains must use https://api.eu.mailgun.net/v3.
const MAILGUN_API_BASE = "https://api.mailgun.net/v3";
const ADMIN_EMAIL = "admin@researchroomies.com";

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
 * kept for now because it is already set as a deployed secret.
 */
function resolveFromAddress(env: Env, fromLocalPart: string): string {
    const configured = env.MAILGUN_SENDING_KEY;
    if (!configured) return `${fromLocalPart}@${MAILGUN_DOMAIN}`;
    return configured.includes("@") ? configured : `${configured}@${MAILGUN_DOMAIN}`;
}

async function sendMailgunMessage(message: MailgunMessage, env: Env): Promise<boolean> {
    const formData = new FormData();
    formData.append("from", `Research Roomies <${resolveFromAddress(env, message.fromLocalPart)}>`);
    formData.append("to", message.to);
    if (message.replyTo) {
        formData.append("h:Reply-To", message.replyTo);
    }
    formData.append("subject", message.subject);
    formData.append("text", message.text);
    formData.append("html", message.html);

    const auth = btoa(`api:${env.MAILGUN_API_KEY}`);

    try {
        const resp = await fetch(`${MAILGUN_API_BASE}/${MAILGUN_DOMAIN}/messages`, {
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
    return sendMailgunMessage({
        fromLocalPart: "login",
        to: email,
        subject: "Log in to Research Roomies",
        text: `Welcome to Research Roomies!

Click the link below to finish logging in:
${link}

This link is valid for 15 minutes.
`,
        html: `<html>
  <body>
    <h3>Welcome to Research Roomies!</h3>
    <p>Click the link below to finish logging in:</p>
    <p><a href="${link}">${link}</a></p>
    <p>This link is valid for 15 minutes.</p>
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
    const postUrl = `https://researchroomies.com/post/${postId}`;

    return sendMailgunMessage({
        fromLocalPart: "noreply",
        to: ADMIN_EMAIL,
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

// NOTE: postTitle and messageContent are interpolated into the HTML body
// unescaped — a known bug, left as-is pending a decision on escaping here.
// escapeHtmlForEmail above is currently applied only in sendReportEmail.
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
    <h3>New Inquiry for "${postTitle}"</h3>
    <p>You have received a new inquiry from <strong>${senderEmail}</strong>.</p>
    <hr />
    <p style="white-space: pre-wrap;">${messageContent}</p>
    <hr />
    <p><small>You can reply directly to this email to respond to the sender.</small></p>
  </body>
</html>`,
    }, env);
}
