import pkmn from "@pkmn/eslint-config";

export default [...pkmn, {
  ignores: ["eslint.config.mjs", ".shots/", "build/", "private/", "teams/*/", "wiki/"]
}, {
  files: ["server/*.{ts,tsx}", "static/build.{ts,tsx}", "tools/*.{ts,tsx}"],
  rules: {
    "@typescript-eslint/no-require-imports": "off",
    "@typescript-eslint/no-var-requires": "off",
  }
}, {
  files: ["test/projects.test.ts"],
  rules: {"jest/no-conditional-expect": "off"}
}];
