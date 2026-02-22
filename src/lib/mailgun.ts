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
