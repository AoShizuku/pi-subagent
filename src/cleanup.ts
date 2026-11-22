// Removes child session directories of other parent sessions after the retention period (docs/06 §8).

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete `<root>/<parentId>/` directories (child transcripts and result files) whose newest file is older
 * than `maxAgeMs`. The current parent's directory is never touched. Best effort: every filesystem error is
 * ignored. Returns the number of directories removed.
 */
export async function cleanupOldSessions(root: string, currentParentId: string, maxAgeMs: number, now = Date.now()): Promise<number> {
	let removed = 0;
	const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of dirs) {
		if (!entry.isDirectory() || entry.name === currentParentId) continue;
		const dir = join(root, entry.name);
		const newest = await newestMtime(dir);
		if (newest === undefined || now - newest <= maxAgeMs) continue;
		await rm(dir, { recursive: true, force: true }).then(
			() => removed++,
			() => {},
		);
	}
	return removed;
}

/** Newest mtime of the directory itself and the files directly inside it. */
async function newestMtime(dir: string): Promise<number | undefined> {
	const own = await stat(dir).catch(() => undefined);
	if (!own) return undefined;
	let newest = own.mtimeMs;
	const names = await readdir(dir).catch(() => [] as string[]);
	for (const name of names) {
		const info = await stat(join(dir, name)).catch(() => undefined);
		if (info) newest = Math.max(newest, info.mtimeMs);
	}
	return newest;
}
