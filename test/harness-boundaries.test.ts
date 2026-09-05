import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const boundaries = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/harness-boundaries.json"), "utf8")) as {
  id: string; boundary: string; file: string; title: string; invariant: string;
}[];

describe("harness regression inventory", () => {
  it("keeps unique, nonempty invariant identifiers", () => {
    expect(boundaries.length).toBeGreaterThan(0);
    expect(new Set(boundaries.map((b) => b.id)).size).toBe(boundaries.length);
    for (const boundary of boundaries) {
      expect(boundary.id.trim()).not.toBe("");
      expect(boundary.boundary.trim()).not.toBe("");
      expect(boundary.invariant.trim()).not.toBe("");
    }
  });

  it.each(boundaries)("$id references an existing executable regression", ({ file, title }) => {
    expect(file).toMatch(/^test\/[\w/-]+\.test\.ts$/);
    const source = readFileSync(resolve(root, file), "utf8");
    // This checks traceability, not whether the referenced regression passes.
    expect(source).toContain(`"${title}"`);
  });
});
