/** @type {import("prettier").Config} */
export default {
  plugins: ["prettier-plugin-svelte"],
  overrides: [{ files: "*.svelte", options: { parser: "svelte" } }],
  printWidth: 100,
  semi: true,
  singleQuote: false,
  svelteSortOrder: "options-scripts-markup-styles",
};
