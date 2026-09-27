// aidlc-sensor-jev-quality.ts — gate sensor that checks planning documents
// piece by piece, using code for text patterns and TypeSafe's Jev classifier
// for semantic judgments.
//
// Jev is a small-context classifier, not a reasoning model. Following the
// TypeSafe docs, this script:
//   - splits each deliverable deterministically (one requirement, one story,
//     one section) and never sends a whole document;
//   - keeps anything code can compute in code (Given/When/Then format, the
//     "As a … I want … so that" pattern, empty and TBD sections);
//   - sends one request per piece, with a named-field state object and every
//     question about that piece asked together;
//   - uses Score for graded judgments and Noul for yes/no conditions, with
//     boundary cases written into the criteria;
//   - decides from the answer probabilities, in three bands: flagged, unsure
//     (for a person to look at), fine.
//
// Checks (requirement checks only in requirements.md, story checks only in
// stories.md; elsewhere those IDs are references):
//   requirement (FR{n}, NFR{n})  measurable (Score), compound (Noul),
//                                on_topic vs the intent statement (Score)
//   story (US{g}.{s})            story parts (code, Noul fallback),
//                                ac_format (code), on_topic (Score)
//   each ## section              filled (code for empty/TBD, Noul otherwise)
//
// Two modes, one per sensor manifest:
//   advisory (jev-quality)  every check above, banded flagged / unsure / fine;
//                           never blocks.
//   blocking (jev-blocking) only serious, near-certain problems: a requirement
//                           with no success condition (Jev, at JEV_BLOCK
//                           confidence), a story with no acceptance criteria,
//                           an empty or TBD section (code). Blocks the gate
//                           until fixed or overridden by a person.
// Code findings are reported by exactly one mode. A Jev "no success
// condition" finding is always reported by advisory mode, and also by
// blocking mode above JEV_BLOCK: Jev answers vary slightly between calls, so
// splitting on its probability could drop a borderline finding from both.
//
// Invocation (by the sensor dispatcher):
//   aidlc-sensor-jev-quality.ts --stage <slug> --output-path <file> [--mode blocking]
//
// Environment:
//   TYPESAFE_API_KEY   required for advisory mode (tool-unavailable without it);
//                      blocking mode runs its code checks without it
//   TYPESAFE_BASE_URL  optional; default https://api.typesafe.ai
//   JEV_MODEL          optional; default jev-1.13
//   JEV_FLAG           optional; probability of a bad answer that flags; 0.7
//   JEV_UNSURE         optional; probability of a bad answer that marks the
//                      piece for a person to look at; 0.3
//   JEV_BLOCK          optional; probability of "no success condition" that
//                      blocks; 0.9
//
// Exit codes follow the dispatcher's truth table: 0 with {pass,...} JSON on
// stdout, 127 when advisory mode has no API key, 1 on API or network failure
// in advisory mode. Blocking mode fails open on a missing key or API failure
// (code checks still run) and says so in its `note`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-1.13";
const DEFAULT_FLAG = 0.7;
const DEFAULT_UNSURE = 0.3;
const DEFAULT_BLOCK = 0.9;
const MAX_ITEM_CHARS = 2000;
const MAX_SECTION_CHARS = 3000;
const MAX_INTENT_CHARS = 1500;
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_STATUSES = new Set([429, 503, 529]);
const MAX_ATTEMPTS = 4;

// Sections whose bodies are protocol sentinels (often just `None.`), not
// content to judge.
const SKIPPED_SECTIONS = new Set([
	"Sources",
	"Assumptions & Open Questions",
	"Assumption Confirmation",
	"Review",
	"Positions",
]);

// The deliverables that define requirements and stories, and the only ones
// whose ID lines are judged as items.
const ITEM_FILES: Record<string, "requirement" | "story"> = {
	"requirements.md": "requirement",
	"stories.md": "story",
};

// One flat character class for the list, quote, table and bold markers before
// an ID: a nested repeat here backtracks exponentially on a long `---` line.
const ITEM_ID = /^[\s#>*|-]*((?:N?FR|US)\d+(?:\.\d+)*)\b/;
const STORY_PATTERN = /\bas an?\b[\s\S]+?\bi (?:want|need|can)\b[\s\S]+?\bso that\b/i;
const GIVEN_WHEN_THEN = /\bgiven\b[\s\S]*?\bwhen\b[\s\S]*?\bthen\b/i;
const HAS_CRITERIA = /\bAC\d+(?:\.\d+)*\b|acceptance criteria|\bgiven\b/i;
const PLACEHOLDER =
	/\b(TBD|TBC|TODO|FIXME)\b|lorem ipsum|\[[^\]]*\b(placeholder|insert|describe|fill in|tbd)\b[^\]]*\]/i;

// --- Jev API types ---

type Text = string | Record<string, unknown> | unknown[];

type Question =
	| { type: "noul"; instructions: Text; criteria?: { true: Text; false: Text } }
	| { type: "score"; instructions: Text; criteria: Text[] };

type Answer =
	| { type: "noul"; noul: number }
	| {
			type: "score";
			score: number;
			probabilities: Record<string, number>;
			confidence: number;
	  }
	| {
			type: "choice";
			choice: string;
			probabilities: Record<string, number>;
			confidence: number;
	  };

type Band = "flagged" | "unsure" | "fine";

interface Item {
	kind: "requirement" | "story" | "section";
	id: string;
	section: string;
	text: string;
}

interface Result {
	item: string;
	check: string;
	band: Band;
	label: string;
	// Probability that the answer is a bad one, or "code" for deterministic
	// checks.
	evidence: number | "code";
	// Serious and near-certain; reported by the blocking check only.
	severe: boolean;
}

interface Bands {
	flag: number;
	unsure: number;
	block: number;
}

type Mode = "advisory" | "blocking";

// --- Questions ---
//
// Score levels run from worst (0) to best (last). Each level describes a
// concrete situation, because the model does not see level numbers or
// neighbours.

const MEASURABLE: Question = {
	type: "score",
	instructions: {
		question: "How verifiable is the success condition stated in `item`?",
		note: "Judge only `item`. TBD, TODO, and bracketed placeholders count as no success condition.",
	},
	criteria: [
		{
			what: "No success condition: the item names a feature or goal but gives nothing a tester could check, or it is a placeholder.",
			examples: ["Support reporting.", "Add a settings page (details TODO)."],
		},
		{
			what: "A success condition is implied but rests on unquantified words such as fast, easy, intuitive, secure, scalable, or user-friendly, with no threshold or observable behaviour.",
			examples: ["Search should be quick and simple."],
		},
		{
			what: "States an observable behaviour or numeric threshold that a tester could check as pass or fail.",
			examples: [
				"Given a logged-in user, when they submit the form, then a receipt is emailed within 60 seconds.",
				"Pages load in under 2 seconds at the 95th percentile.",
			],
		},
	],
};

const COMPOUND: Question = {
	type: "noul",
	instructions:
		"Does `item` ask for two or more independent capabilities that could be built and delivered separately?",
	criteria: {
		true: {
			what: "Several separate capabilities are joined together in one item.",
			examples: ["Users can export reports and manage team billing."],
		},
		false: {
			what: "One capability, possibly with details, conditions, or acceptance steps about that same capability.",
			examples: [
				"Users can export a report as CSV or PDF, and the file downloads within 10 seconds.",
			],
		},
	},
};

const ON_TOPIC: Question = {
	type: "score",
	instructions: {
		question: "How does `item` relate to what `project_intent` sets out to build?",
		note: "Judge whether the item is needed for the intent, not whether it is a good idea.",
	},
	criteria: [
		{
			what: "The item concerns a different product, domain, or goal than `project_intent`.",
		},
		{
			what: "The item is loosely related but adds a feature or concern that `project_intent` neither asks for nor needs.",
			examples: [
				"A social feed, for an intent about booking appointments.",
			],
		},
		{
			what: "The item directly delivers or supports something `project_intent` asks for.",
		},
	],
};

const STORY_PARTS: Record<string, Question> = {
	actor: {
		type: "noul",
		instructions: "Does `item` name who the user, persona, or role is?",
		criteria: {
			true: "A specific user, persona, or role is named, for example a returning customer or a store manager.",
			false: "No user, persona, or role is named.",
		},
	},
	action: {
		type: "noul",
		instructions: "Does `item` state what that user wants to do?",
		criteria: {
			true: "A concrete goal or action is stated.",
			false: "No goal or action is stated.",
		},
	},
	value: {
		type: "noul",
		instructions: "Does `item` state why the user wants it, the benefit or value?",
		criteria: {
			true: "A benefit or reason is stated.",
			false: "No benefit or reason is stated.",
		},
	},
};

const SUBSTANTIVE: Question = {
	type: "noul",
	instructions:
		"Does `section_text` give specific, substantive content for the heading `heading`?",
	criteria: {
		true: "Concrete content specific to this project.",
		false: "Generic filler, a restatement of the heading, or boilerplate that could fit any project.",
	},
};

// --- Banding ---

function band(pBad: number, bands: Bands): Band {
	if (pBad >= bands.flag) return "flagged";
	if (pBad >= bands.unsure) return "unsure";
	return "fine";
}

// Score answers: probability mass on every level below the top one. The
// label names the likeliest bad level.
function judgeScore(
	answer: Answer,
	badLabels: string[],
	bands: Bands,
): { band: Band; label: string; pBad: number } {
	if (answer.type !== "score") throw new JevError("expected a score answer");
	let pBad = 0;
	let worst = badLabels[0];
	let worstP = -1;
	badLabels.forEach((label, level) => {
		const p = answer.probabilities[String(level)] ?? 0;
		pBad += p;
		if (p > worstP) {
			worstP = p;
			worst = label;
		}
	});
	const result = band(pBad, bands);
	return { band: result, label: result === "fine" ? "ok" : worst, pBad };
}

// Noul answers: `badWhenYes` says which direction is the problem.
function judgeNoul(
	answer: Answer,
	badWhenYes: boolean,
	badLabel: string,
	bands: Bands,
): { band: Band; label: string; pBad: number } {
	if (answer.type !== "noul") throw new JevError("expected a noul answer");
	const pBad = badWhenYes ? answer.noul : 1 - answer.noul;
	const result = band(pBad, bands);
	return { band: result, label: result === "fine" ? "ok" : badLabel, pBad };
}

// --- Document splitting (deterministic) ---

// Only IDs of `kind` start a new item; an ID of the other kind inside an item
// (a story citing FR1) is a reference and stays part of that item's text.
function splitItems(body: string, kind: Item["kind"]): Item[] {
	const items: Item[] = [];
	let current: Item | null = null;
	let section = "";
	for (const line of body.split("\n")) {
		const match = ITEM_ID.exec(line);
		const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
		const id = match?.[1];
		if (id && (id.startsWith("US") ? "story" : "requirement") === kind) {
			if (current) items.push(current);
			current = { kind, id, section, text: line };
		} else if (heading) {
			if (current) items.push(current);
			current = null;
			section = heading[1];
		} else if (current) {
			current.text += `\n${line}`;
		}
	}
	if (current) items.push(current);
	// Table rows and repeated mentions can yield the same ID twice; keep the
	// longest block per ID.
	const byId = new Map<string, Item>();
	for (const item of items) {
		const prev = byId.get(item.id);
		if (!prev || item.text.length > prev.text.length) byId.set(item.id, item);
	}
	return [...byId.values()].map((item) => ({
		...item,
		text: item.text.trim().slice(0, MAX_ITEM_CHARS),
	}));
}

function splitSections(body: string): Item[] {
	const sections: Item[] = [];
	let heading: string | null = null;
	let lines: string[] = [];
	const flush = () => {
		if (heading === null || SKIPPED_SECTIONS.has(heading)) return;
		sections.push({
			kind: "section",
			id: heading,
			section: heading,
			text: lines.join("\n").trim().slice(0, MAX_SECTION_CHARS),
		});
	};
	for (const line of body.split("\n")) {
		const match = /^##\s+(.+?)\s*$/.exec(line);
		if (match) {
			flush();
			heading = match[1];
			lines = [];
		} else if (heading !== null) {
			lines.push(line);
		}
	}
	flush();
	return sections;
}

// --- Intent statement lookup ---

// Walk up from the deliverable to the record dir (the one holding
// aidlc-state.md), then find intent-statement.md beneath it.
function findIntentStatement(outputPath: string): string | null {
	let dir = dirname(outputPath);
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "aidlc-state.md"))) {
			const found = findFile(dir, "intent-statement.md", 4);
			return found ? readFileSync(found, "utf-8") : null;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
	if (depth < 0) return null;
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".")) continue;
		const full = join(dir, entry);
		if (entry === name) return full;
		if (statSync(full).isDirectory()) {
			const found = findFile(full, name, depth - 1);
			if (found) return found;
		}
	}
	return null;
}

// --- Jev client ---

class JevError extends Error {}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(
	state: Record<string, unknown>,
	questions: Record<string, Question>,
): Promise<Record<string, Answer>> {
	const baseUrl = (process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const body = JSON.stringify({
		model: process.env.JEV_MODEL ?? DEFAULT_MODEL,
		state,
		questions,
	});
	for (let attempt = 1; ; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetch(`${baseUrl}/v1/systemone`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
					"Content-Type": "application/json",
				},
				body,
				signal: controller.signal,
			});
		} catch (err) {
			throw new JevError(
				`request to ${baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			clearTimeout(timer);
		}
		const raw = await response.text();
		// Rate limited or overloaded: back off exponentially, honouring
		// retry-after when present.
		if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
			const retryAfter = Number(response.headers.get("retry-after"));
			await sleep(
				retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1),
			);
			continue;
		}
		if (!response.ok) {
			throw new JevError(`HTTP ${response.status}: ${raw.slice(0, 500)}`);
		}
		let parsed: { answers?: Record<string, Answer> };
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new JevError(`non-JSON response: ${raw.slice(0, 200)}`);
		}
		if (!parsed.answers) throw new JevError("response has no answers field");
		return parsed.answers;
	}
}

async function mapLimit<T, R>(
	inputs: T[],
	limit: number,
	fn: (input: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(inputs.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, inputs.length) },
		async () => {
			while (next < inputs.length) {
				const index = next++;
				results[index] = await fn(inputs[index]);
			}
		},
	);
	await Promise.all(workers);
	return results;
}


// --- Per-piece checks ---
//
// A result is `severe` when it is serious and near-certain: a requirement
// with no success condition at high confidence, a story with no acceptance
// criteria, an empty or TBD section. The blocking check reports only severe
// results; the advisory check reports everything else, plus severe Jev
// results (see the note in the header).

interface CheckContext {
	mode: Mode;
	documentType: string;
	intent: string | null;
	bands: Bands;
	// Whether Jev may be called. The blocking check still runs its code checks
	// without an API key or when the API is unreachable.
	jev: { enabled: boolean; error: string | null };
}

async function askJev(
	ctx: CheckContext,
	state: Record<string, unknown>,
	questions: Record<string, Question>,
): Promise<Record<string, Answer> | null> {
	if (!ctx.jev.enabled || Object.keys(questions).length === 0) return null;
	try {
		return await evaluate(state, questions);
	} catch (err) {
		// The advisory check reports the failure; the blocking check fails open
		// so an outage cannot hold every approval point.
		if (ctx.mode === "advisory") throw err;
		ctx.jev.error = err instanceof Error ? err.message : String(err);
		return null;
	}
}

function codeResult(item: string, check: string, label: string, severe: boolean): Result {
	return {
		item,
		check,
		band: label === "ok" ? "fine" : "flagged",
		label,
		evidence: "code",
		severe,
	};
}

async function checkItem(item: Item, ctx: CheckContext): Promise<Result[]> {
	const results: Result[] = [];
	const questions: Record<string, Question> = {};

	// Both modes send a requirement's identical request, so they read the same
	// answer: which mode reports a measurability finding then depends only on
	// that answer, and no finding falls between the two checks.
	if (item.kind === "requirement") {
		questions.measurable = MEASURABLE;
		questions.compound = COMPOUND;
		if (ctx.intent) questions.on_topic = ON_TOPIC;
	} else {
		const acFormat = !HAS_CRITERIA.test(item.text)
			? "missing"
			: GIVEN_WHEN_THEN.test(item.text)
				? "ok"
				: "not given-when-then";
		results.push(codeResult(item.id, "ac_format", acFormat, acFormat === "missing"));
		if (ctx.mode === "advisory") {
			// Story parts: the standard sentence pattern settles all three in
			// code; only a story that departs from it goes to Jev.
			if (STORY_PATTERN.test(item.text)) {
				for (const part of Object.keys(STORY_PARTS)) {
					results.push(codeResult(item.id, part, "ok", false));
				}
			} else {
				Object.assign(questions, STORY_PARTS);
			}
		}
	}
	if (item.kind === "story" && ctx.intent && ctx.mode === "advisory") {
		questions.on_topic = ON_TOPIC;
	}

	const state: Record<string, unknown> = {
		document_type: ctx.documentType,
		section: item.section,
		item: item.text,
	};
	if (ctx.intent) state.project_intent = ctx.intent;
	const answers = await askJev(ctx, state, questions);
	if (!answers) return results;

	for (const check of Object.keys(questions)) {
		// The blocking mode asks a requirement's full question set but judges
		// only measurability.
		if (ctx.mode === "blocking" && check !== "measurable") continue;
		const answer = answers[check];
		if (!answer) throw new JevError(`no answer for ${check} on ${item.id}`);
		let severe = false;
		let judged: { band: Band; label: string; pBad: number };
		if (check === "measurable") {
			judged = judgeScore(answer, ["no success condition", "vague"], ctx.bands);
			const pNone = answer.type === "score" ? (answer.probabilities["0"] ?? 0) : 0;
			if (pNone >= ctx.bands.block) {
				severe = true;
				judged = { band: "flagged", label: "no success condition", pBad: pNone };
			}
		} else if (check === "on_topic") {
			judged = judgeScore(answer, ["unrelated", "tangential"], ctx.bands);
		} else if (check === "compound") {
			judged = judgeNoul(answer, true, "compound", ctx.bands);
		} else {
			judged = judgeNoul(answer, false, `${check} absent`, ctx.bands);
		}
		results.push({
			item: item.id,
			check,
			band: judged.band,
			label: judged.label,
			evidence: round2(judged.pBad),
			severe,
		});
	}
	return results;
}

async function checkSection(section: Item, ctx: CheckContext): Promise<Result> {
	if (section.text.replace(/<!--[\s\S]*?-->/g, "").trim() === "") {
		return codeResult(section.id, "filled", "empty", true);
	}
	const marker = PLACEHOLDER.exec(section.text);
	if (marker) return codeResult(section.id, "filled", `placeholder "${marker[0]}"`, true);
	if (ctx.mode === "blocking") return codeResult(section.id, "filled", "ok", false);

	const answers = await askJev(
		ctx,
		{ document_type: ctx.documentType, heading: section.id, section_text: section.text },
		{ filled: SUBSTANTIVE },
	);
	if (!answers) return codeResult(section.id, "filled", "ok", false);
	const answer = answers.filled;
	if (!answer) throw new JevError(`no answer for filled on ${section.id}`);
	const judged = judgeNoul(answer, false, "generic", ctx.bands);
	return {
		item: section.id,
		check: "filled",
		band: judged.band,
		label: judged.label,
		evidence: round2(judged.pBad),
		severe: false,
	};
}

// --- Main ---

function parseFlags(argv: string[]): { stage?: string; outputPath?: string; mode: Mode } {
	const out: { stage?: string; outputPath?: string; mode: Mode } = { mode: "advisory" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--stage") out.stage = argv[++i];
		else if (argv[i] === "--output-path") out.outputPath = argv[++i];
		else if (argv[i] === "--mode") out.mode = argv[++i] === "blocking" ? "blocking" : "advisory";
	}
	return out;
}

function probabilityEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return value > 0 && value <= 1 ? value : fallback;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function emit(result: Record<string, unknown>): never {
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(0);
}

async function main(argv: string[]): Promise<void> {
	const flags = parseFlags(argv);
	const label = flags.mode === "blocking" ? "jev-blocking" : "jev-quality";
	if (!flags.outputPath) {
		process.stderr.write(`${label}: --output-path is required\n`);
		process.exit(2);
	}
	const outputPath = flags.outputPath;
	const name = basename(outputPath);

	// Only judge human-authored markdown deliverables; questions files and
	// the stage diary are scaffolding.
	if (
		!name.endsWith(".md") ||
		name.endsWith("-questions.md") ||
		name === "memory.md" ||
		!existsSync(outputPath)
	) {
		emit({ pass: true, skipped: true, findings: [], findings_count: 0 });
	}

	const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
	if (!hasKey && flags.mode === "advisory") {
		process.stderr.write(`${label}: TYPESAFE_API_KEY is not set\n`);
		process.exit(127);
	}

	const ctx: CheckContext = {
		mode: flags.mode,
		documentType: name.replace(/\.md$/, "").replace(/-/g, " "),
		intent: null,
		bands: {
			flag: probabilityEnv("JEV_FLAG", DEFAULT_FLAG),
			unsure: probabilityEnv("JEV_UNSURE", DEFAULT_UNSURE),
			block: probabilityEnv("JEV_BLOCK", DEFAULT_BLOCK),
		},
		jev: { enabled: hasKey, error: null },
	};
	const body = readFileSync(outputPath, "utf-8");
	// Only the documents that define requirements or stories get item checks.
	// Elsewhere (story maps, delivery plans, traceability notes) the same IDs
	// are references, not definitions.
	const itemKind = ITEM_FILES[name];
	const items = itemKind ? splitItems(body, itemKind) : [];
	const sections = splitSections(body);

	// The intent statement is the reference for the on-topic check, so it is
	// not checked against itself.
	ctx.intent =
		name === "intent-statement.md"
			? null
			: (findIntentStatement(outputPath)?.trim().slice(0, MAX_INTENT_CHARS) ?? null);

	let results: Result[];
	try {
		const itemResults = await mapLimit(items, CONCURRENCY, (item) => checkItem(item, ctx));
		const sectionResults = await mapLimit(sections, CONCURRENCY, (section) =>
			checkSection(section, ctx),
		);
		results = [...itemResults.flat(), ...sectionResults];
	} catch (err) {
		process.stderr.write(`${label}: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}

	const describe = (r: Result) =>
		`${r.item}: ${r.check} → ${r.label} (${r.evidence === "code" ? "code" : `p=${r.evidence}`})`;
	const jevNote = !hasKey
		? "Jev not called: TYPESAFE_API_KEY is not set; code checks only"
		: ctx.jev.error
			? `Jev unavailable (${ctx.jev.error}); code checks only`
			: null;

	if (flags.mode === "blocking") {
		const severe = results.filter((r) => r.severe).map(describe);
		emit({
			pass: severe.length === 0,
			stage: flags.stage,
			file: name,
			block_threshold: ctx.bands.block,
			findings: severe,
			findings_count: severe.length,
			...(jevNote ? { note: jevNote } : {}),
		});
	}

	const scores: Record<string, string> = {};
	for (const check of new Set(results.map((r) => r.check))) {
		const ofCheck = results.filter((r) => r.check === check);
		scores[check] = `${ofCheck.filter((r) => r.band === "fine").length}/${ofCheck.length}`;
	}
	// Severe code results belong to the blocking check, which computes them
	// identically. Jev answers vary slightly between calls, so a severe Jev
	// result stays here too: near the threshold it may show in both checks,
	// but never in neither.
	const reported = results.filter((r) => !(r.severe && r.evidence === "code"));
	const flagged = reported.filter((r) => r.band === "flagged").map(describe);
	const unsure = reported.filter((r) => r.band === "unsure").map(describe);

	emit({
		pass: flagged.length === 0 && unsure.length === 0,
		stage: flags.stage,
		file: name,
		bands: { flag: ctx.bands.flag, unsure: ctx.bands.unsure },
		scores,
		findings: [...flagged, ...unsure.map((u) => `unsure: ${u}`)],
		findings_count: flagged.length + unsure.length,
		flagged_count: flagged.length,
		unsure_count: unsure.length,
		severe_count: results.length - reported.length,
		items_checked: items.length,
		sections_checked: sections.length,
		on_topic_checked: ctx.intent !== null,
	});
}

if (import.meta.main) await main(process.argv.slice(2));

export {
	type Answer,
	type Bands,
	type Question,
	band,
	evaluate,
	findIntentStatement,
	JevError,
	judgeNoul,
	judgeScore,
	main,
	mapLimit,
	probabilityEnv,
	round2,
	splitItems,
	splitSections,
};
