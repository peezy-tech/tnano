import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    deps: {
      alwaysBundle: (id) => id.startsWith("@t-nano/"),
      onlyBundle: false,
    },
    banner: {
      js: "#!/usr/bin/env node\n",
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
