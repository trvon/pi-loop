import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json"],
      include: ["src/**/*.ts"],
      // Type-only modules and test helpers carry no executable logic worth gating.
      exclude: ["src/**/*-types.ts", "src/types.ts"],
      // Floors set just below current actuals (stmts 80%, branches 69.5%,
      // funcs 92.5%, lines 82.9%) to catch regressions. Ratchet up as the
      // runtime/ and tools/ suites land in Phase 4.
      thresholds: {
        statements: 78,
        branches: 67,
        functions: 90,
        lines: 80,
      },
    },
  },
});
