/**
 * The model catalog, read out of the Claude Code installation at refresh time.
 *
 * `--model` accepts an alias, a full Anthropic model id, or a provider-format
 * id — but only ones "this version's model catalog" describes, which is data
 * embedded in the binary (a 200k-line minified bundle or a compiled native
 * build). Two structures are worth mining:
 *
 *  - the id table, `{"first_party":"claude-…","bedrock":…,"vertex":…}` — every
 *    Anthropic model id this CLI knows, first-party id first;
 *  - the alias array, `["sonnet","opus","haiku","fable",…]` — including the
 *    `[1m]` long-context spellings, which the CLI also accepts verbatim.
 *
 * Reading the binary the user already runs is read-only and exact: whatever
 * this version accepts is what the catalog offers. The format is not a
 * contract, so every step falls back: no binary, no table, no aliases — each
 * degrades to the static catalog in `index.ts` rather than to nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CatalogEntry {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: number;
	output: number;
	alias: boolean;
}

/** The alias array the CLI ships, used when the binary scan finds nothing. */
export const FALLBACK_ALIASES = ["fable", "opus", "sonnet", "haiku", "best", "opusplan", "sonnet[1m]", "opus[1m]", "fable[1m]"];

const ALIAS_ANCHOR = '["sonnet","opus","haiku","fable",';
const ID_PATTERN = /\{first_party:"(claude-[A-Za-z0-9._-]+)"/g;

/** Cost is a family heuristic, not the CLI's data — the binary carries no
 *  prices. Categorised on the id so a refreshed catalog still shows usable
 *  figures. */
function familyCosts(id: string): { input: number; output: number; maxTokens: number } {
	if (id.includes("haiku")) return { input: 1, output: 5, maxTokens: 8192 };
	if (id.includes("sonnet")) return { input: 3, output: 15, maxTokens: 64000 };
	if (id.includes("fable") || id.includes("mythos")) return { input: 10, output: 50, maxTokens: 32000 };
	if (id.includes("opus")) return { input: 5, output: 25, maxTokens: 32000 };
	return { input: 3, output: 15, maxTokens: 32000 };
}

/** Everything parseable in one pass over the binary's text. */
export function parseCatalogFromText(text: string): { ids: string[]; aliases: string[] } {
	const ids: string[] = [];
	for (const match of text.matchAll(ID_PATTERN)) {
		const id = match[1];
		if (!ids.includes(id)) ids.push(id);
	}
	let aliases: string[] = [];
	const anchor = text.indexOf(ALIAS_ANCHOR);
	if (anchor !== -1) {
		const open = text.lastIndexOf("[", anchor);
		const close = arrayEnd(text, open);
		if (open !== -1 && close !== -1 && close > anchor && close - open < 4096) {
			try {
				const parsed: unknown = JSON.parse(text.slice(open, close + 1));
				if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
					aliases = parsed as string[];
				}
			} catch { /* the array was not where the anchor pointed */ }
		}
	}
	return { ids, aliases };
}

/** The end of the array that opens at `open`, honoring string contents — the
 *  aliases themselves contain brackets (`sonnet[1m]`), so a naive
 *  `indexOf("]")` cuts the array mid-string. */
function arrayEnd(text: string, open: number): number {
	let depth = 0, inString = false, escaped = false;
	const limit = open + 4096;
	for (let i = open; i < text.length && i < limit; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === "[" || ch === "{") depth++;
		else if (ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Overlapping chunk read: a pattern may straddle a chunk boundary, so each
 *  chunk is read with the tail of the one before it prefixed — sequential
 *  reads, no re-reading, and the overlap never stalls at the end of file. */
export async function scanBinary(binaryPath: string, chunkBytes = 8 << 20, overlapBytes = 1024): Promise<string> {
	return new Promise((resolve, reject) => {
		fs.open(binaryPath, "r", (openError, handle) => {
			if (openError) { reject(openError); return; }
			const parts: string[] = [];
			let carry = "";
			let position = 0;
			const readNext = () => {
				const buffer = Buffer.alloc(chunkBytes);
				fs.read(handle, buffer, 0, chunkBytes, position, (readError, bytesRead) => {
					if (readError) { fs.close(handle, () => reject(readError)); return; }
					if (bytesRead === 0) { fs.close(handle, () => resolve(parts.join(""))); return; }
					const text = carry + buffer.toString("latin1", 0, bytesRead);
					parts.push(text);
					carry = text.slice(Math.max(0, text.length - overlapBytes));
					position += bytesRead;
					readNext();
				});
			};
			readNext();
		});
	});
}

export function resolveClaudeBinary(command: string): string {
	const resolved = command.includes("/") ? command : (() => {
		for (const dir of (process.env.PATH || "").split(":")) {
			const candidate = path.join(dir, command);
			if (fs.existsSync(candidate)) return candidate;
		}
		throw new Error(`Cannot resolve ${command} on PATH`);
	})();
	// A shim may point anywhere; the catalog lives in what actually runs.
	return fs.realpathSync(resolved);
}

/** The full refresh: every model this CLI version accepts, aliases first.
 *  An unreadable or unrecognizable binary degrades to the static alias
 *  catalog rather than failing — a degraded refresh beats an empty one. */
export async function buildCatalog(binaryPath: string): Promise<CatalogEntry[]> {
	let entries: CatalogEntry[] = [];
	try {
		const text = await scanBinary(binaryPath);
		const { ids, aliases } = parseCatalogFromText(text);
		const seen = new Set<string>();
		const add = (id: string, alias: boolean) => {
			if (seen.has(id)) return;
			seen.add(id);
			const costs = familyCosts(id);
			entries.push({
				id,
				name: `Claude Code · ${id}${alias ? " (alias)" : ""}`,
				contextWindow: id.endsWith("[1m]") ? 1_000_000 : 200_000,
				maxTokens: costs.maxTokens,
				input: costs.input,
				output: costs.output,
				alias,
			});
		};
		for (const alias of (aliases.length > 0 ? aliases : FALLBACK_ALIASES)) add(alias, true);
		for (const id of ids) add(id, false);
	} catch {
		// The binary could not be read or carried nothing we know.
	}
	if (entries.length <= 0) {
		entries = FALLBACK_ALIASES.map((id) => ({ ...familyCosts(id), id,
			name: `Claude Code · ${id} (alias)`,
			contextWindow: id.endsWith("[1m]") ? 1_000_000 : 200_000, alias: true }));
	}
	return entries;
}
