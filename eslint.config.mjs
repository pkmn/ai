import pkmn from "@pkmn/eslint-config";

export default [...pkmn, {
  ignores: ["eslint.config.mjs", ".shots/", "build/", "private/", "teams/*/", "wiki/"]
}, {
  files: ["server/**/*.{ts,tsx}", "static/build.{ts,tsx}", "tools/**/*.{ts,tsx}"],
  rules: {
    "@typescript-eslint/no-require-imports": "off",
    "@typescript-eslint/no-var-requires": "off",
  }
}, {
  files: ["arena/**/*.{ts,tsx}", "db/**/*.{ts,tsx}", "server/**/*.{ts,tsx}", "static/**/*.{ts,tsx}"],
  ignores: ["server/teams.ts"],
  rules: {
    "no-restricted-imports": "off",
    "@typescript-eslint/no-restricted-imports": ["error", {
      paths: [
        {
          name: "@pkmn/sim",
          message: "Use server/sim.ts (versioned worker pool) for @pkmn/sim runtime calls, or use `import type`.",
          allowTypeImports: true,
        },
        {
          name: "@pkmn/randoms",
          message: "Use server/sim.ts (versioned worker pool) for @pkmn/randoms runtime calls, or use `import type`.",
          allowTypeImports: true,
        },
      ],
      patterns: [{
        group: ["@pkmn/mods", "@pkmn/mods/*"],
        message: "Use server/sim.ts (versioned worker pool) for @pkmn/mods runtime calls, or use `import type`.",
        allowTypeImports: true,
      }],
    }],
  },
}, {
  files: ["test/projects.test.ts"],
  rules: {"jest/no-conditional-expect": "off"}
}];
