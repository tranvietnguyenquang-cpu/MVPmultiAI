import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [
    "**/node_modules/**",
    "**/.next/**",
    "**/dist/**",
    "packages/database/src/generated/**",
    "packages/relay-v2-persistence/generated/**",
    "packages/relay-v2-persistence/src/generated/**"
  ] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "no-empty": ["error", { "allowEmptyCatch": true }], "@typescript-eslint/no-explicit-any": "off" } },
  { files: ["**/*.mjs"], ...tseslint.configs.disableTypeChecked }
);
