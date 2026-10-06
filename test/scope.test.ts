import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLoopStorageScope, resolveLoopStorePath, resolveTaskStorePath, type ScopeOptions } from "../src/runtime/scope.js";

const CWD = "/tmp/pi-loop-scope";

function opts(overrides: Partial<ScopeOptions> = {}): ScopeOptions {
  return { loopScope: "session", cwd: CWD, ...overrides };
}

describe("resolveLoopStorePath", () => {
  it("returns undefined when PI_LOOP env is 'off'", () => {
    expect(resolveLoopStorePath(opts({ piLoopEnv: "off" }), "s1")).toBeUndefined();
  });

  it("uses an absolute PI_LOOP env path verbatim", () => {
    expect(resolveLoopStorePath(opts({ piLoopEnv: "/custom/loops.json" }), "s1")).toBe("/custom/loops.json");
  });

  it("resolves a relative PI_LOOP env path against cwd", () => {
    expect(resolveLoopStorePath(opts({ piLoopEnv: "./loops.json" }))).toBe(resolve("./loops.json"));
  });

  it("uses a bare PI_LOOP env value as-is", () => {
    expect(resolveLoopStorePath(opts({ piLoopEnv: "named-store" }), "s1")).toBe("named-store");
  });

  it("returns undefined for memory scope", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "memory" }), "s1")).toBeUndefined();
  });

  it("returns a session-scoped path when a sessionId is present", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "session" }), "abc")).toBe(
      join(CWD, ".pi", "loops", "loops-abc.json"),
    );
  });

  it("returns undefined for session scope without a sessionId", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "session" }))).toBeUndefined();
  });

  it("returns the shared project path for project scope", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "project" }), "abc")).toBe(
      join(CWD, ".pi", "loops", "loops.json"),
    );
  });

  it("PI_LOOP env takes precedence over scope", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "memory", piLoopEnv: "/x.json" }))).toBe("/x.json");
  });
});

describe("resolveLoopStorageScope", () => {
  it.each([
    [opts({ loopScope: "memory" }), "s1", "memory"],
    [opts(), undefined, "memory"],
    [opts(), "s1", "session"],
    [opts({ loopScope: "project" }), undefined, "project"],
    [opts({ loopScope: "project", piLoopEnv: "off" }), "s1", "memory"],
    [opts({ piLoopEnv: "/custom/private.json" }), "s1", "custom"],
    [opts({ piLoopEnv: "./private.json" }), undefined, "custom"],
    [opts({ loopScope: "memory", piLoopEnv: "named-store" }), "s1", "custom"],
    [opts({ piLoopEnv: "" }), "s1", "session"],
  ] as const)("classifies the resolved store for %j and session %s as %s", (options, session, expected) => {
    const before = structuredClone(options);
    const scope = resolveLoopStorageScope(options, session);
    expect(scope).toBe(expected);
    expect(scope === "memory").toBe(resolveLoopStorePath(options, session) === undefined);
    expect(options).toEqual(before);
  });
});

describe("resolveTaskStorePath", () => {
  it("returns undefined for memory scope", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "memory" }), "s1")).toBeUndefined();
  });

  it("returns a session-scoped path when a sessionId is present", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "session" }), "abc")).toBe(
      join(CWD, ".pi", "tasks", "tasks-abc.json"),
    );
  });

  it("returns undefined for session scope without a sessionId", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "session" }))).toBeUndefined();
  });

  it("returns the shared project path for project scope", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "project" }), "abc")).toBe(
      join(CWD, ".pi", "tasks", "tasks.json"),
    );
  });

  it("ignores PI_LOOP env (task path is scope-only)", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "project", piLoopEnv: "/x.json" }), "abc")).toBe(
      join(CWD, ".pi", "tasks", "tasks.json"),
    );
  });
});
