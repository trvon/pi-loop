import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyReducerEffect } from "../src/coordinator.js";

// Regression: on Windows, fsync() (FlushFileBuffers) on a read-only directory
// handle throws EPERM. writeSnapshot() fsyncs twice per write — the temp file
// (writable handle, succeeds) then the parent directory (read-only "r" handle,
// EPERM on Windows). Simulate that by throwing on every second fsyncSync call.
const counter = vi.hoisted(() => ({ n: 0, directoryErrorCode: "EPERM" }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		fsyncSync: () => {
			counter.n += 1;
			if (counter.n % 2 === 0) {
				throw Object.assign(
					new Error(`simulated Windows directory fsync ${counter.directoryErrorCode}`),
					{ code: counter.directoryErrorCode },
				);
			}
			// odd calls (the file fsync) succeed
		},
	};
});

// Import the module UNDER TEST after the mock is registered so its named import
// of fsyncSync resolves to the mock above.
const { ReducerBackedStore } = await import("../src/reducer-backed-store.js");

interface Thing {
	id: string;
}
const config = {
	baseDir: join(tmpdir(), "pi-loop-dir-fsync"),
	reduce: (_s: { nextId: number }, _e: never) => ({ state: _s, effects: [] as AnyReducerEffect[] }),
	toReducerState: (nextId: number, _entries: Map<string, Thing>) => ({ nextId }),
	fromReducerState: (state: { nextId: number }) => ({ nextId: state.nextId, entries: new Map<string, Thing>() }),
	serialize: (nextId: number, entries: Map<string, Thing>) => ({ nextId, items: Array.from(entries.keys()) }),
	deserialize: (data: { nextId: number; items: string[] }) => ({
		nextId: data.nextId,
		entries: new Map(data.items.map((id) => [id, { id }] as const)),
	}),
};

class ThingStore extends ReducerBackedStore<Thing, { nextId: number }, never, { nextId: number; items: string[] }> {
	constructor(path?: string) {
		// @ts-expect-error -- minimal config shape satisfies the base constructor at runtime
		super(config, path);
	}
	write(): void {
		this.withLock(() => {
			(this.entries as Map<string, Thing>).set(`t${this.nextId}`, { id: `t${this.nextId}` });
			this.nextId += 1;
		});
	}
}

describe("ReducerBackedStore directory fsync (Windows EPERM)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-loop-dirfsync-"));
		counter.n = 0;
		counter.directoryErrorCode = "EPERM";
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("survives a directory-fsync EPERM and still persists the snapshot", () => {
		const path = join(dir, "things.json");
		const store = new ThingStore(path);

		// Before the fix this threw EPERM out of syncDirectory() on Windows.
		expect(() => store.write()).not.toThrow();
		expect(existsSync(path)).toBe(true);
		const onDisk = JSON.parse(readFileSync(path, "utf-8"));
		expect(onDisk.items).toEqual(["t1"]);
	});

	it("surfaces directory-fsync errors other than Windows EPERM", () => {
		counter.directoryErrorCode = "EIO";
		const store = new ThingStore(join(dir, "things.json"));

		expect(() => store.write()).toThrow(/simulated Windows directory fsync EIO/);
	});
});
