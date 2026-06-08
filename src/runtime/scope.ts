import { join, resolve } from "node:path";

export type LoopScope = "memory" | "session" | "project";

export interface ScopeOptions {
  piLoopEnv?: string;
  loopScope: LoopScope;
  cwd?: string;
}

export function resolveLoopStorePath(options: ScopeOptions, sessionId?: string): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const { piLoopEnv, loopScope } = options;

  if (piLoopEnv === "off") return undefined;
  if (piLoopEnv?.startsWith("/")) return piLoopEnv;
  if (piLoopEnv?.startsWith(".")) return resolve(piLoopEnv);
  if (piLoopEnv) return piLoopEnv;
  if (loopScope === "memory") return undefined;
  if (loopScope === "session" && sessionId) {
    return join(cwd, ".pi", "loops", `loops-${sessionId}.json`);
  }
  if (loopScope === "session") return undefined;
  return join(cwd, ".pi", "loops", "loops.json");
}

export function resolveTaskStorePath(options: ScopeOptions, sessionId?: string): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const { loopScope } = options;

  if (loopScope === "memory") return undefined;
  if (loopScope === "session" && sessionId) {
    return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
  }
  if (loopScope === "session") return undefined;
  return join(cwd, ".pi", "tasks", "tasks.json");
}
