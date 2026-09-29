import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCatalog, FALLBACK_ALIASES, parseCatalogFromText, resolveClaudeBinary, scanBinary } from "../src/catalog.ts";

// A faithful slice of what the binary carries: the id table and the alias
// array, in the shapes the parser anchors on.
const BINARY_TEXT = `
var e1={first_party:"claude-opus-5",bedrock:"us.anthropic.claude-opus-5",vertex:"claude-opus-5"};
var e2={first_party:"claude-sonnet-4-5-20250929",bedrock:"us.anthropic.claude-sonnet-4-5-20250929-v1:0",vertex:"claude-sonnet-4-5@20250929"};
var aj=["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"],B6=["sonnet","opus","haiku","fable"];
`;

test("the id table yields every first-party id, deduped, in order", () => {
	const idsOnly = `var e1={first_party:"claude-opus-5",bedrock:"us.anthropic.claude-opus-5",vertex:"claude-opus-5"};\nvar e3={first_party:"claude-opus-5",bedrock:null};\nvar e2={first_party:"claude-sonnet-4-5-20250929",bedrock:"us.anthropic.claude-sonnet-4-5-20250929-v1:0"};\n`;
	const { ids, aliases } = parseCatalogFromText(idsOnly);
	assert.deepEqual(ids, ["claude-opus-5", "claude-sonnet-4-5-20250929"]);
	assert.equal(aliases.length, 0, "the alias array was not in this text");
});

test("the alias array is parsed whole, and a malformed one is a degradation, not a crash", () => {
	const ok = parseCatalogFromText(BINARY_TEXT);
	assert.deepEqual(ok.aliases, ["sonnet", "opus", "haiku", "fable", "best", "sonnet[1m]", "opus[1m]", "fable[1m]", "opusplan"]);

	// The anchor may point at text that is not the array's start (a truncated
	// binary, a format change): the parser refuses it instead of guessing.
	const broken = parseCatalogFromText('["sonnet","opus","haiku","fable", [x]]');
	assert.deepEqual(broken.aliases, []);
	assert.deepEqual(broken.ids, []);
});

test("a scan never splits a pattern across a chunk boundary", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-test-"));
	try {
		// Padding so the alias array and an id straddle the fixed chunk size.
		const padding = "x".repeat(300);
		const binary = path.join(directory, "fake-claude");
		fs.writeFileSync(binary, padding + BINARY_TEXT);
		const text = await scanBinary(binary, 64, 32);
		const { ids, aliases } = parseCatalogFromText(text);
		assert.deepEqual(aliases.length, 9);
		assert.equal(ids.includes("claude-sonnet-4-5-20250929"), true);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("the catalog is aliases first, then every id, with [1m] windows and family costs", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-build-test-"));
	try {
		const binary = path.join(directory, "claude");
		fs.writeFileSync(binary, BINARY_TEXT);
		const entries = await buildCatalog(binary);

		assert.equal(entries[0].id, "sonnet");
		assert.deepEqual(entries.map((e) => e.id).slice(0, 9),
			["sonnet", "opus", "haiku", "fable", "best", "sonnet[1m]", "opus[1m]", "fable[1m]", "opusplan"],
			"aliases lead, in the binary's own order");
		assert.equal(entries.some((e) => e.id === "claude-opus-5"), true, "the id table follows");
		assert.equal(entries.some((e) => e.id === "claude-sonnet-4-5-20250929"), true);
		assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, "no duplicates between the two tables");

		const long = entries.find((e) => e.id === "sonnet[1m]")!;
		assert.equal(long.contextWindow, 1_000_000, "[1m] is the long-context window");
		const short = entries.find((e) => e.id === "opus")!;
		assert.equal(short.contextWindow, 200_000);
		assert.equal(short.input, 5, "opus prices");
		assert.equal(entries.find((e) => e.id === "haiku")!.input, 1, "haiku prices");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("an unreadable binary falls back to the static alias catalog", async () => {
	const entries = await buildCatalog("/nonexistent/claude-binary-test");
	assert.deepEqual(entries.map((e) => e.id), FALLBACK_ALIASES);
});

test("the command resolves through shims to the binary that carries the catalog", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-resolve-test-"));
	try {
		const real = path.join(directory, "real-claude");
		fs.writeFileSync(real, "fake");
		const shim = path.join(directory, "claude");
		fs.symlinkSync(real, shim);
		assert.equal(resolveClaudeBinary(shim), fs.realpathSync(real));
		assert.throws(() => resolveClaudeBinary("definitely-not-on-path-test"), /Cannot resolve/);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
