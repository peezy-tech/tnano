import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: {
    "*": "vp fmt",
  },
  fmt: {
    ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml", "*.tsbuildinfo"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml", "*.tsbuildinfo"],
    plugins: ["eslint", "oxc", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "eslint/no-await-in-loop": "off",
      "eslint/no-shadow": "off",
      "eslint/no-underscore-dangle": "off",
      "oxc/no-map-spread": "off",
      "typescript/consistent-return": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-sort": "off",
    },
  },
});
