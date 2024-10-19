import pkmn from "@pkmn/eslint-config";

export default [...pkmn, {
  ignores: ["eslint.config.mjs", "build/"],
}, {
  files: ["player.test.ts"],
  rules: {"jest/expect-expect": "off"},
}];
