import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated / scratch / test output
    "playwright-results/**",
    "playwright-report/**",
    "test-results/**",
    "coverage/**",
    "tmp_*",
  ]),
  {
    // Server-side code, tests and scripts are not React components; the React-specific
    // hook rules do not apply and `any` is forbidden outright.
    files: ["src/server/**", "src/worker/**", "tests/**", "scripts/**", "prisma/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
]);

export default eslintConfig;
