import { describe, expect, it } from "vitest";
import scenarioDocument from "./fixtures/controller-routing-scenarios.json";

interface RoutingScenario {
  id: string;
  category: string;
  prompt: string;
  expectedTool: "WorkflowCreate" | "TaskCreate" | "LoopCreate";
  expectedCount: number;
  argumentCheck: "workflow-rework" | "independent-tasks" | "bounded-cron-loop" | "idle-loop";
  holdout: boolean;
}

const document = scenarioDocument as { version: number; scenarios: RoutingScenario[] };

function scenario(id: string): RoutingScenario {
  const found = document.scenarios.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing controller-routing scenario ${id}`);
  return found;
}

describe("controller-routing evaluation scenarios", () => {
  it("locks a versioned, unbiased six-scenario matrix", () => {
    expect(document.version).toBe(1);
    expect(document.scenarios).toHaveLength(6);
    expect(new Set(document.scenarios.map((entry) => entry.id)).size).toBe(6);
    expect(document.scenarios.filter((entry) => entry.holdout)).toHaveLength(3);
    for (const entry of document.scenarios) {
      expect(entry.prompt).not.toMatch(/WorkflowCreate|TaskCreate|LoopCreate/);
      expect(entry.expectedCount).toBeGreaterThan(0);
    }
  });

  it("routes semantic phases to workflows even when users say task or loop", () => {
    expect(scenario("ordered-task-series")).toMatchObject({ expectedTool: "WorkflowCreate", expectedCount: 1 });
    expect(scenario("phased-request-called-loop")).toMatchObject({ expectedTool: "WorkflowCreate", expectedCount: 1 });
    expect(scenario("singular-task-with-rework")).toMatchObject({ expectedTool: "WorkflowCreate", expectedCount: 1 });
  });

  it("keeps independent backlogs and phase-free loops on their native controllers", () => {
    expect(scenario("independent-task-series")).toMatchObject({ expectedTool: "TaskCreate", expectedCount: 3 });
    expect(scenario("bounded-recurring-loop")).toMatchObject({ expectedTool: "LoopCreate", argumentCheck: "bounded-cron-loop" });
    expect(scenario("self-paced-idle-loop")).toMatchObject({ expectedTool: "LoopCreate", argumentCheck: "idle-loop" });
  });
});
