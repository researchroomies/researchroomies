module.exports = async function(eleventyConfig) {
  eleventyConfig.addPassthroughCopy({"templates/style": "style"});
};

module.exports.config = {
  dir: {
    input: "templates/pages",
    output: "public",
    includes: "../layouts",
  }
};