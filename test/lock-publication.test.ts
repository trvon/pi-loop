import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  replaceLegacy: false,
  beforePublish: undefined as ((lockPath: string) => void) | undefined,
  afterPublish: undefined as ((lockPath: string, ownerPath: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync(source: import("node:fs").PathLike, target: import("node:fs").PathLike) {
      if (String(source).endsWith(".candidate")) {
        hooks.beforePublish?.(String(target));
        // Model replacing rename semantics; native behavior is separately checked by Windows CI.
        if (hooks.replaceLegacy && fs.existsSync(target) && fs.statSync(target).isFile()) fs.unlinkSync(target);
      }
      return fs.renameSync(source, target);
    },
    linkSync(source: import("node:fs").PathLike, target: import("node:fs").PathLike) {
      const publication = dirname(String(source)).endsWith(".candidate");
      if (publication) hooks.beforePublish?.(dirname(String(target)));
      fs.linkSync(source, target);
      if (publication) hooks.afterPublish?.(dirname(String(target)), String(target));
    },
  };
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { LoopStore } from "../src/store.js";

const dirs: string[] = [];
afterEach(() => {
  hooks.replaceLegacy = false;
  hooks.beforePublish = undefined;
  hooks.afterPublish = undefined;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-publication-"));
  dirs.push(dir);
  const path = join(dir, "loops.json");
  const store = new LoopStore(path);
  store.create({ type: "dynamic" }, "original", { recurring: true });
  const before = readFileSync(path, "utf8");
  let tick = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (tick += 100));
  return { dir, path, lockPath: `${path}.lock`, store, before };
}

function expectUnchanged(f: ReturnType<typeof fixture>) {
  expect(readFileSync(f.path, "utf8")).toBe(f.before);
  expect(f.store.list()).toHaveLength(1);
  expect(readdirSync(f.dir).filter((name) => name.endsWith(".candidate"))).toEqual([]);
}

describe("non-replacing initialized lock claims", () => {
  it.each(["", `${process.pid}:`, `${process.pid}:live-owner`])("preserves a closed legacy file with contents %j even with replacing rename", (contents) => {
    const f = fixture();
    writeFileSync(f.lockPath, contents);
    const inode = statSync(f.lockPath).ino;
    hooks.replaceLegacy = true;
    expect(() => f.store.create({ type: "dynamic" }, "must not enter", {})).toThrow(/lock/i);
    expect(readFileSync(f.lockPath, "utf8")).toBe(contents);
    expect(statSync(f.lockPath).ino).toBe(inode);
    expectUnchanged(f);
  });

  it("preserves a live legacy file appearing immediately before publication", () => {
    const f = fixture();
    hooks.replaceLegacy = true;
    hooks.beforePublish = (lockPath) => {
      hooks.beforePublish = undefined;
      if (existsSync(lockPath)) rmdirSync(lockPath);
      writeFileSync(lockPath, `${process.pid}:late-legacy`);
    };
    expect(() => f.store.create({ type: "dynamic" }, "must not enter", {})).toThrow(/lock/i);
    expect(hooks.beforePublish).toBeUndefined();
    expect(readFileSync(f.lockPath, "utf8")).toBe(`${process.pid}:late-legacy`);
    expectUnchanged(f);
  });

  it("does not enter a live directory replacing empty scaffolding before publication", () => {
    const f = fixture();
    hooks.beforePublish = (lockPath) => {
      hooks.beforePublish = undefined;
      if (existsSync(lockPath)) rmdirSync(lockPath);
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, `owner-${process.pid}-replacement`), `${process.pid}:replacement`);
    };
    expect(() => f.store.create({ type: "dynamic" }, "must not enter", {})).toThrow(/lock/i);
    expect(readdirSync(f.lockPath)).toEqual([`owner-${process.pid}-replacement`]);
    expectUnchanged(f);
  });

  it("a contender cannot enter while an initialized claim is awaiting admission", () => {
    const f = fixture();
    let publications = 0;
    hooks.afterPublish = (_lockPath, ownerPath) => {
      hooks.afterPublish = undefined;
      publications++;
      expect(readFileSync(ownerPath, "utf8")).toMatch(new RegExp(`^${process.pid}:[0-9a-f-]+$`));
      const contender = new LoopStore(f.path);
      expect(() => contender.create({ type: "dynamic" }, "contender", {})).toThrow(/lock/i);
      expect(readFileSync(f.path, "utf8")).toBe(f.before);
      expect(existsSync(ownerPath)).toBe(true);
    };
    f.store.create({ type: "dynamic" }, "owner", {});
    expect(publications).toBe(1);
    expect(f.store.list().map((entry) => entry.prompt)).toEqual(["original", "owner"]);
    expect(existsSync(f.lockPath)).toBe(false);
  });

  it("retries APFS EINVAL when empty scaffolding disappears during publication", () => {
    const f = fixture();
    hooks.beforePublish = (lockPath) => {
      hooks.beforePublish = undefined;
      rmdirSync(lockPath);
      throw Object.assign(new Error("scaffolding disappeared during link"), { code: "EINVAL", syscall: "link" });
    };
    f.store.create({ type: "dynamic" }, "retried", {});
    expect(hooks.beforePublish).toBeUndefined();
    expect(f.store.list()).toHaveLength(2);
    expect(existsSync(f.lockPath)).toBe(false);
  });

  it("withdraws only its own claim on inspection failure", () => {
    const f = fixture();
    hooks.afterPublish = () => {
      hooks.afterPublish = undefined;
      throw Object.assign(new Error("publication inspection failed"), { code: "EIO" });
    };
    expect(() => f.store.create({ type: "dynamic" }, "must not enter", {})).toThrow(/inspection/);
    expectUnchanged(f);
    expect(!existsSync(f.lockPath) || readdirSync(f.lockPath).length === 0).toBe(true);
    f.store.create({ type: "dynamic" }, "recovered", {});
    expect(f.store.list()).toHaveLength(2);
  });

  it.each([false, true])("reclaims individually dead claims without stealing live claims (live=%s)", (live) => {
    const f = fixture();
    mkdirSync(f.lockPath);
    writeFileSync(join(f.lockPath, "owner-999999-dead-a"), "999999:dead-a");
    writeFileSync(join(f.lockPath, "owner-999998-dead-b"), "999998:dead-b");
    if (live) writeFileSync(join(f.lockPath, `owner-${process.pid}-live`), `${process.pid}:live`);
    if (live) {
      expect(() => f.store.create({ type: "dynamic" }, "must not enter", {})).toThrow(/lock/i);
      expect(readdirSync(f.lockPath)).toEqual([`owner-${process.pid}-live`]);
      expectUnchanged(f);
    } else {
      f.store.create({ type: "dynamic" }, "recovered", {});
      expect(f.store.list()).toHaveLength(2);
      expect(existsSync(f.lockPath)).toBe(false);
    }
  });
});
