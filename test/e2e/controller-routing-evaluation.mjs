const CONTROLLER_TOOLS = new Set(["WorkflowCreate", "TaskCreate", "LoopCreate"]);

export function assistantModelMetadata(event) {
  const message = event.message;
  if (event.type !== "message_end" || message?.role !== "assistant"
    || typeof message.provider !== "string" || !message.provider
    || typeof message.model !== "string" || !message.model) return undefined;
  return {
    provider: message.provider.slice(0, 256),
    model: message.model.slice(0, 256),
    ...(typeof message.api === "string" ? { api: message.api.slice(0, 256) } : {}),
  };
}

export function createModelObservationCollector() {
  const observedModels = new Set();
  let omittedModelObservations = 0;
  return {
    observe(event) {
      const metadata = assistantModelMetadata(event);
      if (!metadata) return;
      const key = JSON.stringify(metadata);
      if (observedModels.has(key) || observedModels.size < 8) observedModels.add(key);
      else omittedModelObservations += 1;
    },
    snapshot() {
      return {
        observedModels: [...observedModels].map((metadata) => JSON.parse(metadata)),
        omittedModelObservations,
      };
    },
  };
}

function hasDirectedCycle(definition) {
  const states = definition?.states;
  if (!states || typeof states !== "object") return false;
  const visiting = new Set();
  const visited = new Set();
  function visit(stateId) {
    if (visiting.has(stateId)) return true;
    if (visited.has(stateId) || !states[stateId]) return false;
    visiting.add(stateId);
    for (const target of Object.values(states[stateId].on ?? {})) {
      if (typeof target === "string" && visit(target)) return true;
    }
    visiting.delete(stateId);
    visited.add(stateId);
    return false;
  }
  return Object.keys(states).some(visit);
}

function validateWorkflowArgs(args) {
  if (typeof args?.goal !== "string" || !args.goal.trim() || typeof args.definition !== "string") return false;
  let definition;
  try {
    definition = JSON.parse(args.definition);
  } catch {
    return false;
  }
  const states = definition?.states;
  if (definition?.version !== 1 || typeof definition.initialState !== "string" || !states?.[definition.initialState]) return false;
  const values = Object.values(states);
  if (values.length < 3 || values.some((state) => typeof state?.prompt !== "string" || !state.prompt.trim())) return false;
  const taskCount = values.filter((state) => typeof state?.task?.subject === "string" && typeof state?.task?.description === "string").length;
  const branchCount = values.filter((state) => Object.keys(state?.on ?? {}).length >= 2).length;
  const terminalCount = values.filter((state) => state?.terminal === "completed" || state?.terminal === "paused").length;
  return taskCount >= 2 && branchCount >= 1 && terminalCount >= 1 && hasDirectedCycle(definition);
}

function validateIndependentTasks(calls) {
  if (calls.length === 0) return false;
  const subjects = calls.map((call) => call.args?.subject);
  return calls.every((call) => typeof call.args?.subject === "string" && call.args.subject.trim()
      && typeof call.args?.description === "string" && call.args.description.trim().length >= 20)
    && new Set(subjects).size === calls.length;
}

function validateBoundedCronLoop(args) {
  const trigger = String(args?.trigger ?? "").toLowerCase();
  return args?.maxFires === 12
    && args?.recurring !== false
    && (trigger === "10m" || trigger.includes("*/10"))
    && /health|healthy/.test(String(args?.prompt ?? "").toLowerCase());
}

function validateIdleLoop(args) {
  return String(args?.trigger ?? "").toLowerCase() === "idle"
    && args?.triggerType === "idle"
    && args?.recurring !== false
    && /broken.*link|link.*broken/.test(String(args?.prompt ?? "").toLowerCase());
}

function successfulCall(call, toolResults) {
  const result = toolResults.get(call.toolCallId);
  return Boolean(result && !result.isError && result.tone !== "error");
}

function semanticArgumentsFor(scenario, calls) {
  let semanticArguments = false;
  if (scenario.argumentCheck === "workflow-rework") {
    semanticArguments = calls.length === 1 && validateWorkflowArgs(calls[0]?.args);
  } else if (scenario.argumentCheck === "independent-tasks") {
    semanticArguments = calls.length === scenario.expectedCount && validateIndependentTasks(calls);
  } else if (scenario.argumentCheck === "bounded-cron-loop") {
    semanticArguments = calls.length === 1 && validateBoundedCronLoop(calls[0]?.args);
  } else if (scenario.argumentCheck === "idle-loop") {
    semanticArguments = calls.length === 1 && validateIdleLoop(calls[0]?.args);
  }
  return semanticArguments;
}

export function evaluateScenario(scenario, toolCalls, toolResults, agentRuns, durationMs) {
  const controllerCalls = toolCalls.filter((call) => CONTROLLER_TOOLS.has(call.name));
  const expectedCalls = controllerCalls.filter((call) => call.name === scenario.expectedTool);
  const successfulExpectedCalls = expectedCalls.filter((call) => successfulCall(call, toolResults));
  const unexpectedCalls = controllerCalls.filter((call) => call.name !== scenario.expectedTool);
  const exactRoute = successfulExpectedCalls.length === scenario.expectedCount && unexpectedCalls.length === 0;
  const cleanExecution = exactRoute && successfulCall(expectedCalls.at(-1), toolResults);
  const semanticArguments = semanticArgumentsFor(scenario, successfulExpectedCalls);
  const firstBatch = controllerCalls.slice(0, scenario.expectedCount);
  const firstAttemptValid = firstBatch.length === scenario.expectedCount
    && firstBatch.every((call) => call.name === scenario.expectedTool && successfulCall(call, toolResults));
  const firstAttemptSemantic = firstAttemptValid && semanticArgumentsFor(scenario, firstBatch);
  const firstTurn = successfulExpectedCalls.length === scenario.expectedCount
    && controllerCalls.every((call) => call.agentRun === 1);

  const checklist = [
    { id: "route", critical: true, passed: exactRoute },
    { id: "execution", critical: true, passed: cleanExecution },
    { id: "arguments", critical: false, passed: semanticArguments },
    { id: "single-turn", critical: false, passed: firstTurn },
  ];
  const success = checklist.filter((item) => item.critical).every((item) => item.passed);
  const accuracy = checklist.filter((item) => item.passed).length / checklist.length;
  return {
    id: scenario.id,
    category: scenario.category,
    holdout: scenario.holdout,
    success,
    accuracy,
    durationMs,
    toolUses: toolCalls.length,
    retryCount: expectedCalls.length - successfulExpectedCalls.length,
    firstAttemptValid,
    firstAttemptSemantic,
    agentRuns,
    checklist,
    expected: { tool: scenario.expectedTool, count: scenario.expectedCount },
    actual: controllerCalls.map((call) => ({ name: call.name, args: call.args })),
    errors: controllerCalls.flatMap((call) => {
      const result = toolResults.get(call.toolCallId);
      return result?.isError || result?.tone === "error" ? [`${call.name}: ${result.text.slice(0, 500)}`] : [];
    }),
  };
}
