import type { toolCost } from "./tool-context-report.js";

export const BUDGET_FIELDS = ["description", "parameters", "parameterDescriptions", "declaration"] as const;
type BudgetField = typeof BUDGET_FIELDS[number];
type Limits = Record<BudgetField, number>;
type Cost = ReturnType<typeof toolCost>;

export interface ToolContextBudget {
  baseline: Record<string, Limits>;
  limits: { total: Limits; tools: Record<string, Limits> };
}

export function checkToolContextBudget(costs: readonly Cost[], budget: ToolContextBudget): string[] {
  const failures: string[] = [];
  if (!budget?.limits?.tools || !budget.limits.total) return ["Missing tool context budget limits"];
  const scopes: Array<[string, Limits]> = [["total", budget.limits.total], ...Object.entries(budget.limits.tools)];
  for (const [scope, limits] of scopes) {
    for (const field of BUDGET_FIELDS) {
      if (!Number.isSafeInteger(limits?.[field]) || limits[field] < 0) failures.push(`Invalid budget limit: ${scope}.${field}`);
    }
  }
  if (failures.length) return failures;
  const seen = new Set<string>();
  for (const cost of costs) {
    if (seen.has(cost.name)) failures.push(`Duplicate tool: ${cost.name}`);
    seen.add(cost.name);
    const limits = Object.hasOwn(budget.limits.tools, cost.name) ? budget.limits.tools[cost.name] : undefined;
    if (!limits) {
      failures.push(`Unbudgeted tool: ${cost.name}`);
      continue;
    }
    for (const field of BUDGET_FIELDS) {
      if (cost[field].bytes > limits[field]) failures.push(`${cost.name}.${field}: ${cost[field].bytes} > ${limits[field]} bytes`);
    }
  }
  for (const name of Object.keys(budget.limits.tools)) {
    if (!seen.has(name)) failures.push(`Missing budgeted tool: ${name}`);
  }
  for (const field of BUDGET_FIELDS) {
    const total = costs.reduce((sum, cost) => sum + cost[field].bytes, 0);
    if (total > budget.limits.total[field]) failures.push(`total.${field}: ${total} > ${budget.limits.total[field]} bytes`);
  }
  return failures;
}
