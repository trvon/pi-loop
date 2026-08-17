import { Type } from "typebox";

export const WorkflowTaskSchema = Type.Object({
  subject: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
});

export const WorkflowLoopSchema = Type.Object({
  schedule: Type.String({ minLength: 1 }),
  maxFires: Type.Optional(Type.Integer({ minimum: 1 })),
  startImmediately: Type.Optional(Type.Boolean()),
});

export const WorkflowStateSchema = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  task: Type.Optional(WorkflowTaskSchema),
  loop: Type.Optional(WorkflowLoopSchema),
  on: Type.Optional(Type.Record(Type.String(), Type.String())),
  terminal: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("paused")])),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const WorkflowDefinitionSchema = Type.Object({
  version: Type.Literal(1),
  initialState: Type.String({ minLength: 1 }),
  states: Type.Record(Type.String(), WorkflowStateSchema),
});

export const WorkflowRevisionChangeSchema = Type.Union([
  Type.Object({
    op: Type.Literal("add_state"),
    stateId: Type.String({ minLength: 1 }),
    state: WorkflowStateSchema,
  }),
  Type.Object({
    op: Type.Literal("revise_state"),
    stateId: Type.String({ minLength: 1 }),
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    task: Type.Optional(WorkflowTaskSchema),
    loop: Type.Optional(WorkflowLoopSchema),
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  Type.Object({
    op: Type.Literal("add_transition"),
    from: Type.String({ minLength: 1 }),
    outcome: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    op: Type.Literal("redirect_transition"),
    from: Type.String({ minLength: 1 }),
    outcome: Type.String({ minLength: 1 }),
    expectedTo: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
  }),
]);

export const WorkflowDefinitionRevisionSchema = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
  definition: WorkflowDefinitionSchema,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  supersededAt: Type.Number({ minimum: 0 }),
  supersededBy: Type.Object({
    sessionId: Type.String({ minLength: 1 }),
    runtimeId: Type.String({ minLength: 1 }),
  }),
  changes: Type.Array(WorkflowRevisionChangeSchema, { minItems: 1, maxItems: 64 }),
});
