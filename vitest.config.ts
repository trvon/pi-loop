import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // CI runners are slower than local; 15s gives real-child-process
    // tests (monitor stop, lifecycle) enough headroom.
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json"],
      include: ["src/**/*.ts"],
      // Type-only modules and test helpers carry no executable logic worth gating.
      exclude: ["src/**/*-types.ts", "src/types.ts"],
      // Floors set just below current actuals (stmts 91%, branches 83%,
      // funcs 98%, lines 94%) to catch regressions. Re-anchored after the
      // goal-subsystem removal and the rpc/native-task-rpc/command suites landed.
      thresholds: {
        statements: 89,
        branches: 80,
        functions: 96,
        lines: 91,
      },
    },
  },
});
