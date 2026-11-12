import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { LoopStore } from "../src/store.js";
import { cardGlyphs, detectGlyphTier, getGlyphTier, parseGlyphTier, setGlyphTier } from "../src/ui/card-style.js";
import { panelLineText, taskCardPreview } from "../src/ui/progress-panel.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";
import { PANEL_NOW, panelTask } from "./helpers/progress-panel-fixtures.js";

const utf8 = { LANG: "en_US.UTF-8", TERM: "xterm-256color" };

// Feature expectations: no production defect/red-reproduction claim.
describe("card glyphs", () => {
  afterEach(() => setGlyphTier("unicode"));

  it("never selects private-use icons unless the operator opts in", () => {
    expect(getGlyphTier()).toBe("unicode");
    expect(detectGlyphTier(utf8)).toBe("unicode");
    // A terminal name is not proof the font draws the icons; a miss renders blank.
    expect(detectGlyphTier({ ...utf8, TERM_PROGRAM: "ghostty", GHOSTTY_RESOURCES_DIR: "/x" })).toBe("unicode");
    expect(detectGlyphTier({ ...utf8, TERM_PROGRAM: "WezTerm", POWERLEVEL9K_MODE: "nerdfont-complete" })).toBe("unicode");
    expect(detectGlyphTier({ ...utf8, NERD_FONT: "1" })).toBe("nerd");
    expect(detectGlyphTier({ ...utf8, PI_LOOP_GLYPHS: " Nerd " })).toBe("nerd");
  });

  it("falls back to ASCII without a UTF-8 locale, and lets an explicit choice win", () => {
    expect(detectGlyphTier({})).toBe("ascii");
    expect(detectGlyphTier({ LANG: "C", NERD_FONT: "1" })).toBe("ascii");
    expect(detectGlyphTier({ ...utf8, TERM: "linux" })).toBe("ascii");
    expect(detectGlyphTier({ ...utf8, TERM: "dumb" })).toBe("ascii");
    expect(detectGlyphTier({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe("ascii");
    expect(detectGlyphTier({ LANG: "C", PI_LOOP_GLYPHS: "unicode" })).toBe("unicode");
    expect(detectGlyphTier({ ...utf8, PI_LOOP_GLYPHS: "ASCII" })).toBe("ascii");
    expect(detectGlyphTier({ ...utf8, PI_LOOP_GLYPHS: "fancy" })).toBe("unicode");
    expect(parseGlyphTier("fancy")).toBeUndefined();
  });

  it("keeps ASCII 7-bit, the default free of private-use glyphs, and structure portable in every tier", () => {
    for (const value of Object.values(cardGlyphs("ascii"))) expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(Object.values(cardGlyphs("unicode")).join("")).not.toMatch(/[\ue000-\uf8ff]/);
    // Brackets and separators must survive a missing icon font.
    for (const tier of ["nerd", "unicode", "ascii"] as const) {
      const glyphs = cardGlyphs(tier);
      expect(`${glyphs.currentOpen}${glyphs.currentClose}${glyphs.outcomeJoin}`).toBe("[]|");
      expect(glyphs.field).not.toMatch(/[\ue000-\uf8ff]/);
    }
  });

  it("restyles the task preview without changing which tasks it shows", () => {
    const tasks = [
      panelTask("3", "in_progress", "Write parser", { claimedAt: PANEL_NOW - 1, leaseExpiresAt: PANEL_NOW - 1 }),
      panelTask("1", "pending", "Add tests"),
      panelTask("9", "completed", "Done already"),
    ];
    const line = () => taskCardPreview(tasks, PANEL_NOW).map(panelLineText)[0];
    expect(line()).toBe("  ■#3 STALE Write parser │ □#1 Add tests");
    setGlyphTier("ascii");
    expect(line()).toBe("  *#3 STALE Write parser | -#1 Add tests");
    expect(taskCardPreview([panelTask("9", "completed")], PANEL_NOW)).toEqual([]);
  });

  it("switches glyphs with /loop glyphs, shows a sample, and never creates a loop", async () => {
    const { pi, commandMap } = createMockPi();
    const store = new LoopStore();
    const add = vi.fn();
    registerLoopCommand({ pi, getStore: () => store as any, getTriggerSystem: () => ({ add, remove: vi.fn() }) as any, updateWidget: vi.fn() });
    const command = commandMap.get("loop")!;
    const ctx = createCtx();

    await command.handler!("glyphs", ctx);
    expect(ctx.notifications.at(-1)?.message).toBe("Card glyphs: unicode. Use /loop glyphs nerd, unicode, or ascii.");
    await command.handler!("glyphs ASCII", ctx);
    expect(getGlyphTier()).toBe("ascii");
    expect(ctx.notifications.at(-1)?.message).toContain("+plan > [build] | >> pass|retry");
    await command.handler!("glyphs sparkles", ctx);
    expect(getGlyphTier()).toBe("ascii");
    expect(store.list()).toEqual([]);
    expect(add).not.toHaveBeenCalled();

    await command.handler!("glyphsmith the parser", ctx);
    expect(store.list()).toHaveLength(1);
  });
});
