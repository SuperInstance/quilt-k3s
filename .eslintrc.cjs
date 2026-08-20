/* eslint-env node */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: ["./tsconfig.json"],
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    "dist/",
    "node_modules/",
    "coverage/",
    "*.cjs",
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-console": "off",
    "no-process-exit": "off",
    "prefer-const": "error",
    "eqeqeq": ["error", "smart"],
    "no-var": "error",
  },
  overrides: [
    {
      files: ["test/**/*.ts"],
      rules: {
        "@typescript-eslint/no-non-null-assertion": "off",
        "no-console": "off",
      },
    },
  ],
};
