export async function sendMagicLink(
    email: string,
    link: string,
    env: Env
): Promise<boolean> {
    const MAILGUN_DOMAIN = "researchroomies.com";
    const API_KEY = env.MAILGUN_API_KEY;

    let fromAddress = "login@researchroomies.com";
    if (env.MAILGUN_SENDING_KEY && !env.MAILGUN_SENDING_KEY.includes("@")) {
        fromAddress = `${env.MAILGUN_SENDING_KEY}@researchroomies.com`;
    } else if (env.MAILGUN_SENDING_KEY) {
        fromAddress = env.MAILGUN_SENDING_KEY;
    }

    const formData = new FormData();
    formData.append("from", `Research Roomies <${fromAddress}>`);
    formData.append("to", email);
    formData.append("subject", "Log in to Research Roomies");
    formData.append("text", `Welcome to Research Roomies!

Click the link below to finish logging in:
${link}

This link is valid for 15 minutes.
`);
    formData.append("html", `<html>
  <body>
    <h3>Welcome to Research Roomies!</h3>
    <p>Click the link below to finish logging in:</p>
    <p><a href="${link}">${link}</a></p>
    <p>This link is valid for 15 minutes.</p>
  </body>
</html>`);

    const auth = btoa(`api:${API_KEY}`);

    try {
        const resp = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
            method: "POST",
            headers: {
                Authorization: `Basic ${auth}`,
            },
            body: formData,
        });

        if (!resp.ok) {
            console.error("Mailgun error:", await resp.text());
            return false;
        }

        return true;
    } catch (e) {
        console.error("Mailgun exception:", e);
        return false;
    }
}

/**
 * Local to this function only — the two functions above interpolate user
 * content into their HTML bodies unescaped (a known bug); do not touch them.
 * New code should escape, so this stays scoped to sendReportEmail.
 */
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
    const MAILGUN_DOMAIN = "researchroomies.com";
    const API_KEY = env.MAILGUN_API_KEY;

    let fromAddress = "noreply@researchroomies.com";
    if (env.MAILGUN_SENDING_KEY && !env.MAILGUN_SENDING_KEY.includes("@")) {
        fromAddress = `${env.MAILGUN_SENDING_KEY}@researchroomies.com`;
    } else if (env.MAILGUN_SENDING_KEY) {
        fromAddress = env.MAILGUN_SENDING_KEY;
    }

    const postUrl = `https://researchroomies.com/post/${postId}`;

    const formData = new FormData();
    formData.append("from", `Research Roomies <${fromAddress}>`);
    formData.append("to", "admin@researchroomies.com");
    formData.append("subject", `Post reported: ${postTitle}`);
    formData.append("text", `A post has been reported on Research Roomies.\n\nPost: ${postTitle} (#${postId})\nLink: ${postUrl}\nReason: ${reason}\nReported by: ${reporterEmail}\n`);
    formData.append("html", `<html>
  <body>
    <h3>Post Reported</h3>
    <p><strong>Post:</strong> ${escapeHtmlForEmail(postTitle)} (#${postId})</p>
    <p><strong>Link:</strong> <a href="${postUrl}">${postUrl}</a></p>
    <p><strong>Reason:</strong> ${escapeHtmlForEmail(reason)}</p>
    <p><strong>Reported by:</strong> ${escapeHtmlForEmail(reporterEmail)}</p>
  </body>
</html>`);

    const auth = btoa(`api:${API_KEY}`);

    try {
        const resp = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
            method: "POST",
            headers: {
                Authorization: `Basic ${auth}`,
            },
            body: formData,
        });

        if (!resp.ok) {
            console.error("Mailgun error:", await resp.text());
            return false;
        }

        return true;
    } catch (e) {
        console.error("Mailgun exception:", e);
        return false;
    }
}

export async function sendInquiryEmail(
    authorEmail: string,
    senderEmail: string,
    postTitle: string,
    messageContent: string,
    env: Env
): Promise<boolean> {
    const MAILGUN_DOMAIN = "researchroomies.com";
    const API_KEY = env.MAILGUN_API_KEY;

    let fromAddress = "noreply@researchroomies.com";
    if (env.MAILGUN_SENDING_KEY && !env.MAILGUN_SENDING_KEY.includes("@")) {
        fromAddress = `${env.MAILGUN_SENDING_KEY}@researchroomies.com`;
    } else if (env.MAILGUN_SENDING_KEY) {
        fromAddress = env.MAILGUN_SENDING_KEY;
    }

    const formData = new FormData();
    formData.append("from", `Research Roomies <${fromAddress}>`);
    formData.append("to", authorEmail);
    formData.append("h:Reply-To", senderEmail);
    formData.append("subject", `New Inquiry for your post: ${postTitle}`);
    formData.append("text", `You have received a new inquiry from ${senderEmail} regarding your post "${postTitle}".\n\nMessage:\n${messageContent}\n\nYou can reply directly to this email to respond to the sender.\n`);
    formData.append("html", `<html>
  <body>
    <h3>New Inquiry for "${postTitle}"</h3>
    <p>You have received a new inquiry from <strong>${senderEmail}</strong>.</p>
    <hr />
    <p style="white-space: pre-wrap;">${messageContent}</p>
    <hr />
    <p><small>You can reply directly to this email to respond to the sender.</small></p>
  </body>
</html>`);

    const auth = btoa(`api:${API_KEY}`);

    try {
        const resp = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
            method: "POST",
            headers: {
                Authorization: `Basic ${auth}`,
            },
            body: formData,
        });

        if (!resp.ok) {
            console.error("Mailgun error:", await resp.text());
            return false;
        }

        return true;
    } catch (e) {
        console.error("Mailgun exception:", e);
        return false;
    }
}
