import prettierPluginSvelte from "prettier-plugin-svelte";

/** @type {import("prettier").Config} */
export default {
  plugins: [prettierPluginSvelte],
  printWidth: 100,
  trailingComma: "all",
};
