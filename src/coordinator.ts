export type ReducerSource =
  | "tool"
  | "command"
  | "scheduler"
  | "eventbus"
  | "monitor"
  | "session"
  | "coordinator"
  | "system";

export type ReducerEntityType = "task" | "loop" | "monitor" | "notification";

export interface ReducerEvent<TType extends string = string, TPayload = unknown> {
  type: TType;
  at: number;
  source: ReducerSource;
  entityType?: ReducerEntityType;
  entityId?: string;
  payload: TPayload;
}

export interface ReducerEffect<TEffect extends string = string, TPayload = unknown> {
  type: TEffect;
  entityType?: ReducerEntityType;
  entityId?: string;
  payload: TPayload;
}

export type DispatchEventEffect = ReducerEffect<"DISPATCH_EVENT", { event: ReducerEvent }>;
export type AnyReducerEffect = ReducerEffect | DispatchEventEffect;

export type ReducerHandler =
  (event: ReducerEvent) => undefined | AnyReducerEffect[] | Promise<undefined | AnyReducerEffect[]>;

export type EffectHandler =
  (effect: ReducerEffect) => void | Promise<void>;

export interface CoordinatorOptions {
  reducers: ReducerHandler[];
  effectHandlers?: Partial<Record<string, EffectHandler>>;
  effectExecutor?: EffectHandler;
  maxDispatchDepth?: number;
}

export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

export interface Coordinator {
  dispatch(event: ReducerEvent): Promise<void>;
}

export function createCoordinator(options: CoordinatorOptions): Coordinator {
  const {
    reducers,
    effectHandlers = {},
    effectExecutor,
    maxDispatchDepth = 100,
  } = options;

  function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return typeof value === "object" && value !== null && "then" in value;
  }

  async function executeEffect(effect: AnyReducerEffect, depth: number): Promise<void> {
    if (effect.type === "DISPATCH_EVENT") {
      const dispatchEffect = effect as DispatchEventEffect;
      const derivedEvent = dispatchEffect.payload.event;
      if (!derivedEvent) {
        throw new CoordinatorError("DISPATCH_EVENT effect missing payload.event");
      }
      await dispatchAtDepth(derivedEvent, depth + 1);
      return;
    }

    const specificHandler = effectHandlers[effect.type];
    if (specificHandler) {
      const handled = specificHandler(effect);
      if (isPromiseLike(handled)) await handled;
      return;
    }

    if (effectExecutor) {
      const handled = effectExecutor(effect);
      if (isPromiseLike(handled)) await handled;
    }
  }

  async function dispatchAtDepth(event: ReducerEvent, depth: number): Promise<void> {
    if (depth > maxDispatchDepth) {
      throw new CoordinatorError(`Maximum dispatch depth exceeded (${maxDispatchDepth})`);
    }

    const effects: AnyReducerEffect[] = [];
    for (const reducer of reducers) {
      const emitted = reducer(event);
      const resolved = isPromiseLike(emitted) ? await emitted : emitted;
      if (!resolved || resolved.length === 0) continue;
      effects.push(...resolved);
    }

    for (const effect of effects) {
      await executeEffect(effect, depth);
    }
  }

  return {
    async dispatch(event: ReducerEvent): Promise<void> {
      await dispatchAtDepth(event, 1);
    },
  };
}
