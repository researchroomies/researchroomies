const fs = require("node:fs");
const path = require("node:path");

/**
 * The Turnstile sitekey has exactly one definition: TURNSTILE_SITE_KEY in
 * [vars] in wrangler.toml. The Worker reads it from `env` at request time;
 * Eleventy reads it from the same file at build time, so the two Nunjucks
 * widgets cannot drift from the two the Worker renders.
 *
 * Missing is a hard build failure rather than an empty attribute: an empty
 * sitekey renders a dead widget on /login and /create, and `npm run deploy`
 * runs this build first, so failing here stops it shipping.
 */
function readTurnstileSiteKey() {
  const wranglerPath = path.join(__dirname, "wrangler.toml");
  const toml = fs.readFileSync(wranglerPath, "utf8");
  const match = toml.match(/^\s*TURNSTILE_SITE_KEY\s*=\s*"([^"]+)"/m);

  if (!match) {
    throw new Error(
      "TURNSTILE_SITE_KEY is missing from [vars] in wrangler.toml. It is the " +
        "single definition of the Turnstile sitekey — the login, create-post, " +
        "inquiry and report widgets all read from it."
    );
  }

  return match[1];
}

module.exports = async function(eleventyConfig) {
  eleventyConfig.addPassthroughCopy({"templates/style": "style"});
  eleventyConfig.addGlobalData("turnstileSiteKey", readTurnstileSiteKey());
};

module.exports.config = {
  dir: {
    input: "templates/pages",
    output: "public",
    includes: "../layouts",
  }
};
