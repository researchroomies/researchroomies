module.exports = async function(eleventyConfig) {
  eleventyConfig.addPassthroughCopy({"templates/style": "style"});

  // Consumed by templates/layouts/base.njk, which is generated from
  // renderShell() in src/lib/shell.mjs — see scripts/gen-layout.mjs.
  //
  // `year` used to be referenced by the layout without ever being defined, so
  // every built page shipped "© ResearchRoomies" with a blank year while
  // Worker-rendered pages showed the real one.
  eleventyConfig.addGlobalData("year", new Date().getFullYear());

  // Absolute origin for <link rel="canonical"> and og:url. The Worker builds
  // the same URLs from the incoming request; static pages have no request.
  eleventyConfig.addGlobalData("siteOrigin", "https://researchroomies.com");
};

module.exports.config = {
  dir: {
    input: "templates/pages",
    output: "public",
    includes: "../layouts",
  }
};
