// aidlc-sensor-jev-gaps.ts — advisory gate sensor that looks for concerns a
// requirements document never addresses, using a fixed checklist and
// TypeSafe's Jev classifier.
//
// Jev is a classifier, not a reasoning model, so it is never asked "what is
// missing?". The checklist is supplied by code: AI-DLC's requirements
// completeness checklist plus two concerns that reviews keep catching (who a
// record belongs to, and where reference data comes from). For each concern
// Jev answers two narrow yes/no questions in one request:
//   addressed  is it covered anywhere: a requirement, constraint, assumption,
//              out-of-scope line or open question?
//   relevant   would a product with this intent need a decision on it?
// A gap is a concern that is relevant and not addressed:
//   P(gap) = P(relevant) × P(not addressed)
// banded with this check's own thresholds (a product of two probabilities
// runs lower than a single answer): flagged at JEV_GAPS_FLAG, unsure at
// JEV_GAPS_UNSURE. Relevance is a three-level Score whose top level is
// "the product depends on a decision"; the relevance question is what keeps a proof of concept from
// being told it lacks pagination or localisation.
//
// Runs on requirements.md only. State per request: the intent statement, the
// requirement items, and the other non-protocol sections as named fields,
// never the raw document.
//
// Invocation (by the sensor dispatcher):
//   aidlc-sensor-jev-gaps.ts --stage <slug> --output-path <file>
//
// Environment: TYPESAFE_API_KEY, TYPESAFE_BASE_URL and JEV_MODEL as
// jev-quality, plus
//   JEV_GAPS_FLAG       optional; probability of a gap that flags; 0.5
//   JEV_GAPS_UNSURE     optional; probability of a gap that marks the concern
//                       for a person to look at; 0.4
//   JEV_GAPS_CHECKLIST  optional; path to a JSON array of {"id", "concern"}
//                       that replaces the default checklist
//
// Exit codes: 0 with {pass,...} JSON on stdout, 127 without an API key, 1 on
// API or network failure or an unreadable checklist.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	type Answer,
	type Bands,
	band,
	evaluate,
	findIntentStatement,
	JevError,
	mapLimit,
	probabilityEnv,
	type Question,
	round2,
	splitItems,
	splitSections,
} from "./aidlc-sensor-jev-quality.ts";

// Starting points from three labelled documents (tests/fixtures/gaps/).
const DEFAULT_FLAG = 0.5;
const DEFAULT_UNSURE = 0.4;
const MAX_INTENT_CHARS = 1500;
const MAX_REQUIREMENTS_CHARS = 5000;
const MAX_DECISIONS_CHARS = 2500;
const CONCURRENCY = 6;

interface Concern {
	id: string;
	concern: string;
}

// AI-DLC's completeness checklist (knowledge/aidlc-product-agent/
// requirements-guide.md), reworded as concrete concerns, with ownership,
// reference data and record lifecycle added.
const DEFAULT_CHECKLIST: Concern[] = [
	{
		id: "ownership",
		concern:
			"Who each record belongs to and how its owner is identified, for example a customer name, contact detail, account or order reference.",
	},
	{
		id: "reference_data",
		concern:
			"Where the reference data the product relies on comes from and who maintains it, for example the product catalogue, prices or stock levels.",
	},
	{
		id: "record_lifecycle",
		concern:
			"How records change state over time and what ends them, for example expiry, completion, cancellation or no-shows.",
	},
	{
		id: "access_control",
		concern:
			"Who may use which functions: sign-in, and restricting staff or admin functions to the people allowed to use them.",
	},
	{
		id: "input_validation",
		concern: "What happens with invalid, missing or empty input.",
	},
	{
		id: "error_messages",
		concern: "What users see when something goes wrong.",
	},
	{
		id: "search_filtering",
		concern: "Searching and filtering lists of records.",
	},
	{
		id: "pagination",
		concern: "Paging through long lists of records.",
	},
	{
		id: "audit_logging",
		concern: "Keeping an audit log of sensitive operations.",
	},
	{
		id: "notifications",
		concern: "Notifying users or staff by email, SMS or push when something happens.",
	},
	{
		id: "export_import",
		concern: "Exporting or importing data.",
	},
	{
		id: "concurrency",
		concern: "Two people changing the same record or resource at the same time.",
	},
	{
		id: "sessions",
		concern: "Session length and what happens when a session times out.",
	},
	{
		id: "offline",
		concern: "Working offline, without a network connection.",
	},
	{
		id: "localisation",
		concern: "Supporting several languages, currencies or regional formats.",
	},
	{
		id: "accessibility",
		concern: "Accessibility for people using assistive technology.",
	},
	{
		id: "retention",
		concern: "How long data is kept and when it is deleted.",
	},
];

const QUESTIONS: Record<string, Question> = {
	addressed: {
		type: "noul",
		instructions:
			"Do `requirements` or `decisions` cover the concern described in `concern`?",
		criteria: {
			true: "A requirement, constraint, assumption, out-of-scope line or open question deals with this concern, even briefly or only to exclude it.",
			false: "Nothing in `requirements` or `decisions` deals with this concern.",
		},
	},
	relevant: {
		type: "score",
		instructions: {
			question:
				"How much does the product described in `project_intent` depend on a decision about the concern described in `concern`?",
			note: "Judge the product as `project_intent` describes it, at its stated size, not a larger or later version.",
		},
		criteria: [
			{
				what: "The concern does not arise for this product, or only matters for a larger or later version of it.",
				examples: ["Paging through long lists, for a proof of concept used by one shop."],
			},
			{
				what: "Deciding it would be good practice, but the product can be built and used end to end without it.",
			},
			{
				what: "The product's main flow cannot work as described, or a builder would have to guess, until this is decided.",
				examples: ["Who an order belongs to, for an app where staff hand orders to customers."],
			},
		],
	},
};

interface Gap {
	id: string;
	band: "flagged" | "unsure" | "fine";
	pGap: number;
	pRelevant: number;
	pAddressed: number;
}

function loadChecklist(): Concern[] {
	const path = process.env.JEV_GAPS_CHECKLIST;
	if (!path) return DEFAULT_CHECKLIST;
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		!parsed.every(
			(c) =>
				c &&
				typeof c.id === "string" &&
				/^[a-z][a-z0-9_]*$/.test(c.id) &&
				typeof c.concern === "string" &&
				c.concern.trim() !== "",
		)
	) {
		throw new Error(
			`${path}: expected a non-empty JSON array of {"id": "snake_case", "concern": "text"}`,
		);
	}
	return parsed as Concern[];
}

function noul(answer: Answer | undefined): number {
	if (answer?.type !== "noul") throw new JevError("expected a noul answer");
	return answer.noul;
}

// Probability of the top Score level: the product depends on a decision.
function topLevel(answer: Answer | undefined): number {
	if (answer?.type !== "score") throw new JevError("expected a score answer");
	const levels = Object.keys(answer.probabilities).map(Number);
	return answer.probabilities[String(Math.max(...levels))] ?? 0;
}

// A gap needs the concern to be relevant and unaddressed.
function judgeGap(id: string, pRelevant: number, pAddressed: number, bands: Bands): Gap {
	const pGap = pRelevant * (1 - pAddressed);
	return {
		id,
		band: band(pGap, bands),
		pGap: round2(pGap),
		pRelevant: round2(pRelevant),
		pAddressed: round2(pAddressed),
	};
}

// The fields Jev sees: requirement lines, and every other non-protocol
// section by heading (intent analysis, constraints, assumptions, out of
// scope, open questions), each trimmed to fit a small context.
function buildState(body: string): {
	requirements: string[];
	decisions: Record<string, string>;
} {
	const items = splitItems(body, "requirement");
	const requirements: string[] = [];
	let used = 0;
	for (const item of items) {
		if (used + item.text.length > MAX_REQUIREMENTS_CHARS) break;
		requirements.push(item.text);
		used += item.text.length;
	}
	const decisions: Record<string, string> = {};
	used = 0;
	for (const section of splitSections(body)) {
		// Sections holding requirement items are already in `requirements`,
		// including those whose items sit under `###` subheadings.
		if (section.text === "" || splitItems(section.text, "requirement").length > 0) continue;
		const text = section.text.slice(0, MAX_DECISIONS_CHARS - used);
		if (text === "") break;
		decisions[section.id] = text;
		used += text.length;
	}
	return { requirements, decisions };
}

function emit(result: Record<string, unknown>): never {
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(0);
}

async function main(argv: string[]): Promise<void> {
	let stage: string | undefined;
	let outputPath: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--stage") stage = argv[++i];
		else if (argv[i] === "--output-path") outputPath = argv[++i];
	}
	if (!outputPath) {
		process.stderr.write("jev-gaps: --output-path is required\n");
		process.exit(2);
	}
	const name = basename(outputPath);
	if (name !== "requirements.md" || !existsSync(outputPath)) {
		emit({ pass: true, skipped: true, findings: [], findings_count: 0 });
	}
	if (!process.env.TYPESAFE_API_KEY) {
		process.stderr.write("jev-gaps: TYPESAFE_API_KEY is not set\n");
		process.exit(127);
	}

	const bands: Bands = {
		flag: probabilityEnv("JEV_GAPS_FLAG", DEFAULT_FLAG),
		unsure: probabilityEnv("JEV_GAPS_UNSURE", DEFAULT_UNSURE),
		block: 1,
	};
	const body = readFileSync(outputPath, "utf-8");
	const { requirements, decisions } = buildState(body);
	// Relevance is judged against the approved intent statement; without it,
	// the document's own intent analysis is the next best reference.
	const intent =
		findIntentStatement(outputPath)?.trim().slice(0, MAX_INTENT_CHARS) ??
		Object.entries(decisions)
			.find(([heading]) => /intent/i.test(heading))?.[1]
			.slice(0, MAX_INTENT_CHARS) ??
		null;
	if (intent === null || requirements.length === 0) {
		emit({
			pass: true,
			skipped: true,
			stage,
			file: name,
			note:
				intent === null
					? "No intent statement or intent analysis found to judge relevance against."
					: "No requirement items found.",
			findings: [],
			findings_count: 0,
		});
	}

	let gaps: Gap[];
	try {
		const checklist = loadChecklist();
		gaps = await mapLimit(checklist, CONCURRENCY, async (concern) => {
			const answers = await evaluate(
				{
					document_type: "requirements",
					project_intent: intent,
					requirements,
					decisions,
					concern: concern.concern,
				},
				QUESTIONS,
			);
			return judgeGap(
				concern.id,
				topLevel(answers.relevant),
				noul(answers.addressed),
				bands,
			);
		});
	} catch (err) {
		process.stderr.write(`jev-gaps: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}

	const describe = (g: Gap) =>
		`${g.id}: not addressed (p=${g.pGap}; relevant ${g.pRelevant}, addressed ${g.pAddressed})`;
	const flagged = gaps.filter((g) => g.band === "flagged").map(describe);
	const unsure = gaps.filter((g) => g.band === "unsure").map(describe);
	emit({
		pass: flagged.length === 0 && unsure.length === 0,
		stage,
		file: name,
		bands: { flag: bands.flag, unsure: bands.unsure },
		scores: { covered: `${gaps.filter((g) => g.band === "fine").length}/${gaps.length}` },
		findings: [...flagged, ...unsure.map((u) => `unsure: ${u}`)],
		findings_count: flagged.length + unsure.length,
		flagged_count: flagged.length,
		unsure_count: unsure.length,
		concerns_checked: gaps.length,
		concerns: Object.fromEntries(
			gaps.map((g) => [g.id, { gap: g.pGap, relevant: g.pRelevant, addressed: g.pAddressed }]),
		),
	});
}

if (import.meta.main) await main(process.argv.slice(2));

export { buildState, DEFAULT_CHECKLIST, judgeGap, loadChecklist, main, topLevel };
