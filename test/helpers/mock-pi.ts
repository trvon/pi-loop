// VENDORED TEST HARNESS — canonical copy lives in pi-loop; pi-orca vendors
// this file verbatim under test/helpers/. Keep divergences behind options.
import { vi } from "vitest";

export interface MockPiOptions {
  /** Respond to `tasks:rpc:ping` so the extension treats pi-tasks as installed. */
  respondToTaskPing?: boolean;
  /** Respond to `tasks:rpc:pending` with this count when the extension queries the backlog. */
  pendingTaskCount?: () => number;
  /** Respond to `tasks:rpc:create` with this task id (treats pi-tasks as the task backend). */
  respondToTaskCreate?: () => string;
  /**
   * Respond to `tasks:rpc:clean` with a canned `{ success: true }` (default true —
   * disable when a real tasks:rpc server under test owns the channel).
   */
  respondToTaskClean?: boolean;
  /** Respond to `tasks:rpc:update` with a canned reply built from the request. */
  respondToTaskUpdate?: (request: any) => { task: any } | { error: string };
  /** Respond to `subagents:rpc:spawn` with this agent id (simulates pi-subagents). */
  respondToSubagentSpawn?: (request: any) => string;
  /** Swallow `monitor:done` emits (used to isolate the direct-callback path). */
  suppressMonitorDoneDispatch?: boolean;
}

export interface RegisteredTool {
  name: string;
  execute?: (...args: any[]) => any;
  [key: string]: unknown;
}

export interface RegisteredCommand {
  description?: string;
  handler?: (...args: any[]) => any;
  [key: string]: unknown;
}

export interface MockPi {
  /** The pi object passed to the extension. `events.emit`/`events.on` are `vi.fn` spies. */
  pi: any;
  /** Tools registered via `pi.registerTool`. */
  toolMap: Map<string, RegisteredTool>;
  /** Commands registered via `pi.registerCommand`. */
  commandMap: Map<string, RegisteredCommand>;
  /** Extension lifecycle handlers registered via `pi.on`. */
  extensionHandlers: Map<string, Array<(data: any, ctx: any) => unknown>>;
  /** Event-bus handlers registered via `pi.events.on`. */
  eventHandlers: Map<string, Array<(data: any) => void>>;
  /** Messages sent via `pi.sendMessage` (custom/steer messages). */
  sentMessages: Array<{ message: any; options?: any }>;
  /** Messages sent via `pi.sendUserMessage`. */
  sentUserMessages: Array<{ message: string; options?: any }>;
  /** Every event emitted via `pi.events.emit`, in order. */
  emittedEvents: Array<{ name: string; payload: any }>;
  /** Drive an extension lifecycle handler (e.g. `turn_start`) to completion. */
  emitExtension: (name: string, payload: any, ctx: any) => Promise<void>;
}

/**
 * Single shared pi mock for all test suites. Supersedes the five per-file
 * `createMockPi` variants. `events.emit`/`events.on` are `vi.fn` spies that
 * also perform real handler dispatch, so suites can assert on `.mock.calls`
 * or rely on listeners firing.
 */
export function createMockPi(options: MockPiOptions = {}): MockPi {
  const toolMap = new Map<string, RegisteredTool>();
  const commandMap = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<string, Array<(data: any) => void>>();
  const extensionHandlers = new Map<string, Array<(data: any, ctx: any) => unknown>>();
  const sentMessages: Array<{ message: any; options?: any }> = [];
  const sentUserMessages: Array<{ message: string; options?: any }> = [];
  const emittedEvents: Array<{ name: string; payload: any }> = [];

  const events = {
    emit: vi.fn((name: string, payload: any) => {
      emittedEvents.push({ name, payload });

      if (name === "tasks:rpc:ping" && payload?.requestId && options.respondToTaskPing) {
        queueMicrotask(() => {
          events.emit(`tasks:rpc:ping:reply:${payload.requestId}`, {
            success: true,
            data: { version: 1 },
          });
        });
        return;
      }

      if (name === "tasks:rpc:pending" && payload?.requestId && options.pendingTaskCount) {
        queueMicrotask(() => {
          events.emit(`tasks:rpc:pending:reply:${payload.requestId}`, {
            success: true,
            data: { pending: options.pendingTaskCount?.() ?? 0 },
          });
        });
        return;
      }

      if (name === "tasks:rpc:create" && payload?.requestId && options.respondToTaskCreate) {
        queueMicrotask(() => {
          events.emit(`tasks:rpc:create:reply:${payload.requestId}`, {
            success: true,
            data: { id: options.respondToTaskCreate?.() ?? "rpc-1" },
          });
        });
        return;
      }

      if (name === "tasks:rpc:clean" && payload?.requestId && options.respondToTaskClean !== false) {
        queueMicrotask(() => {
          events.emit(`tasks:rpc:clean:reply:${payload.requestId}`, { success: true });
        });
        return;
      }

      if (name === "tasks:rpc:update" && payload?.requestId && options.respondToTaskUpdate) {
        queueMicrotask(() => {
          const result = options.respondToTaskUpdate?.(payload);
          events.emit(
            `tasks:rpc:update:reply:${payload.requestId}`,
            result && "error" in result
              ? { success: false, error: result.error }
              : { success: true, data: result },
          );
        });
        return;
      }

      if (name === "subagents:rpc:spawn" && payload?.requestId && options.respondToSubagentSpawn) {
        queueMicrotask(() => {
          events.emit(`subagents:rpc:spawn:reply:${payload.requestId}`, {
            success: true,
            data: { id: options.respondToSubagentSpawn?.(payload) ?? "agent-1" },
          });
        });
        return;
      }

      if (name === "monitor:done" && options.suppressMonitorDoneDispatch) {
        return;
      }

      for (const cb of eventHandlers.get(name) ?? []) cb(payload);
    }),
    on: vi.fn((name: string, handler: (data: any) => void) => {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
      return () => {
        const arr = eventHandlers.get(name);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
      };
    }),
  };

  const pi: any = {
    events,
    on(name: string, handler: (data: any, ctx: any) => unknown) {
      const handlers = extensionHandlers.get(name) ?? [];
      handlers.push(handler);
      extensionHandlers.set(name, handlers);
    },
    registerTool(tool: RegisteredTool) {
      toolMap.set(tool.name, tool);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commandMap.set(name, command);
    },
    sendMessage(message: any, opts?: any) {
      sentMessages.push({ message, options: opts });
    },
    sendUserMessage(message: string, opts?: any) {
      sentUserMessages.push({ message, options: opts });
    },
  };

  async function emitExtension(name: string, payload: any, ctx: any) {
    for (const handler of extensionHandlers.get(name) ?? []) {
      await handler(payload, ctx);
    }
  }

  return {
    pi,
    toolMap,
    commandMap,
    extensionHandlers,
    eventHandlers,
    sentMessages,
    sentUserMessages,
    emittedEvents,
    emitExtension,
  };
}

export interface MockCtxOptions {
  hasPendingMessages?: boolean;
  cwd?: string;
  isIdle?: boolean;
  sessionId?: string;
}

/**
 * Standard extension context used by lifecycle-handler tests. Superset of the
 * ctx shapes both pi-loop (setStatus/setWidget, hasPendingMessages) and
 * pi-orca (notify, cwd, isIdle) depend on. `notifications` records every
 * ui.notify call. Accepts a bare boolean for backward compatibility with
 * `createCtx(hasPendingMessages)` call sites.
 */
export function createCtx(options: boolean | MockCtxOptions = false) {
  const opts = typeof options === "boolean" ? { hasPendingMessages: options } : options;
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    ui: {
      setStatus() {},
      setWidget() {},
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    notifications,
    cwd: opts.cwd ?? process.cwd(),
    isIdle: () => opts.isIdle ?? true,
    hasPendingMessages: () => opts.hasPendingMessages ?? false,
    sessionManager: { getSessionId: () => opts.sessionId ?? "test-session" },
  };
}

/**
 * Drain pending async work (multi-hop RPC reply chains) for the runtime
 * integration suites. These suites do not use fake timers, so a real macrotask
 * tick is the correct, fully-draining flush — a single microtask is not enough.
 */
export async function flushAsync() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
