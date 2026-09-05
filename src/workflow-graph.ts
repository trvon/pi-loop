import type { WorkflowRunState } from "./types.js";
import { getWorkflowOutcomeAvailability } from "./workflow-reducer.js";

export interface WorkflowGraphWarning {
  code: "closed_cycle" | "dead_end" | "exhausted_route";
  states: string[];
  edges?: Array<{ from: string; outcome: string; to: string }>;
}

type Graph = Map<string, string[]>;

function reachable(graph: Graph, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of graph.get(id) ?? []) if (!seen.has(next)) pending.push(next);
  }
  return seen;
}

function reversed(graph: Graph): Graph {
  const result: Graph = new Map([...graph.keys()].map((id) => [id, []]));
  for (const [from, targets] of graph) for (const to of targets) result.get(to)?.push(from);
  return result;
}

function components(graph: Graph): string[][] {
  const seen = new Set<string>();
  const finish: string[] = [];
  // Iterative DFS also handles long legacy plans without using the JS call stack.
  for (const root of graph.keys()) {
    const stack: Array<[string, boolean]> = [[root, false]];
    while (stack.length) {
      const [id, exiting] = stack.pop()!;
      if (exiting) { finish.push(id); continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push([id, true]);
      for (const next of graph.get(id) ?? []) if (!seen.has(next)) stack.push([next, false]);
    }
  }
  const reverse = reversed(graph);
  seen.clear();
  const result: string[][] = [];
  for (const root of finish.reverse()) {
    if (seen.has(root)) continue;
    const group: string[] = [];
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(id);
      for (const next of reverse.get(id) ?? []) if (!seen.has(next)) stack.push(next);
    }
    result.push(group.sort());
  }
  return result;
}

/** Warning-only read model over an already validated workflow; not a liveness proof. */
export function diagnoseWorkflowGraph(run: WorkflowRunState): WorkflowGraphWarning[] {
  const states = run.definition.states;
  const ids = Object.keys(states).sort();
  const graph: Graph = new Map(ids.map((id) => [id, [...new Set(Object.values(states[id]?.on ?? {}))].filter((target) => Object.hasOwn(states, target)).sort()]));
  const warnings: WorkflowGraphWarning[] = [];
  for (const group of components(graph)) {
    if (group.some((id) => states[id]?.terminal)) continue;
    const members = new Set(group);
    if (group.some((id) => graph.get(id)?.some((next) => !members.has(next)))) continue;
    const cycle = group.length > 1 || graph.get(group[0]!)?.includes(group[0]!);
    warnings.push({ code: cycle ? "closed_cycle" : "dead_end", states: group });
  }

  const terminals = ids.filter((id) => states[id]?.terminal);
  const terminalReachable = reachable(reversed(graph), terminals);
  const live: Graph = new Map();
  const blocked: NonNullable<WorkflowGraphWarning["edges"]> = [];
  for (const id of ids) {
    const availability = getWorkflowOutcomeAvailability({ ...run, currentState: id });
    live.set(id, availability.available.map((outcome) => states[id]!.on![outcome]!).filter((target) => Object.hasOwn(states, target)));
    for (const edge of availability.unavailable) {
      if ("maxAttempts" in edge) blocked.push({ from: id, outcome: edge.outcome, to: edge.targetState });
    }
  }
  const currentReachable = reachable(live, [run.currentState]);
  if (terminalReachable.has(run.currentState) && !terminals.some((id) => currentReachable.has(id))) {
    const edges = blocked.filter((edge) => currentReachable.has(edge.from) && terminalReachable.has(edge.to))
      .sort((a, b) => `${a.from}.${a.outcome}` < `${b.from}.${b.outcome}` ? -1 : `${a.from}.${a.outcome}` > `${b.from}.${b.outcome}` ? 1 : 0);
    warnings.push({ code: "exhausted_route", states: [run.currentState], edges });
  }
  return warnings.sort((a, b) => {
    const left = `${a.code}:${a.states.join(",")}`;
    const right = `${b.code}:${b.states.join(",")}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function formatWorkflowGraphWarnings(run: WorkflowRunState): string[] {
  const warnings = diagnoseWorkflowGraph(run);
  const lines = warnings.slice(0, 3).map((warning) => {
    const names = warning.states.slice(0, 4).join(", ");
    const suffix = warning.states.length > 4 ? ` (+${warning.states.length - 4} states)` : "";
    const detail = warning.code === "closed_cycle" ? "cycle has no declared exit"
      : warning.code === "dead_end" ? "nonterminal state has no outcome"
        : "no terminal route remains under current attempt limits";
    return `Graph warning: ${names}${suffix} — ${detail}. Inspect/revise the graph if finite completion is intended.`;
  });
  if (warnings.length > 3) lines.push(`Graph warnings: ${warnings.length - 3} more; inspect diagnoseWorkflowGraph via the public API for full witnesses.`);
  return lines;
}
