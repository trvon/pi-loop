import type { LoopStore } from "../../src/store.js";

function currentWorkflow(store: Pick<LoopStore, "get">, id: string) {
  const workflow = store.get(id)?.workflow;
  if (!workflow) throw new Error(`Workflow #${id} unavailable in test`);
  return workflow;
}

export function currentWorkflowIdentity(store: Pick<LoopStore, "get">, id: string) {
  const workflow = currentWorkflow(store, id);
  return {
    currentState: workflow.currentState,
    transitionSeq: workflow.transitionSeq,
    definitionRevision: workflow.definitionRevision,
    activeExecutionId: workflow.activeExecution?.id,
  };
}

export function currentMonitorAttachmentIdentity(store: Pick<LoopStore, "get">, id: string) {
  const workflow = currentWorkflow(store, id);
  return {
    stateId: workflow.currentState,
    transitionSeq: workflow.transitionSeq,
    definitionRevision: workflow.definitionRevision,
    activeExecutionId: workflow.activeExecution?.id,
  };
}
