import pkmn from "@pkmn/eslint-config";

export default [...pkmn, {
  ignores: ["eslint.config.mjs", "build/", "baselines/"]
}, {
  files: ["server/index.ts", "static/build.ts"],
  rules: {
    "@typescript-eslint/no-require-imports": "off",
    "@typescript-eslint/no-var-requires": "off",
  }
}, {
  files: ["test/projects.test.ts"],
  rules: {"jest/no-conditional-expect": "off"}
}];
