// The jev plugin's own tests.
//
// Offline tests always run: document splitting, banding, the gap checklist,
// and how the sensors behave without an API key. The live tests run the
// labelled bakery sample and the labelled gap documents through the real Jev
// API and only run when JEV_LIVE=1 and TYPESAFE_API_KEY are set (they send the
// fixture text to TypeSafe or the configured TYPESAFE_BASE_URL).
//
// Run: bun test tests/

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	band,
	judgeNoul,
	judgeScore,
	splitItems,
	splitSections,
} from "../tools/aidlc-sensor-jev-quality.ts";
import {
	buildState,
	DEFAULT_CHECKLIST,
	judgeGap,
	loadChecklist,
	topLevel,
} from "../tools/aidlc-sensor-jev-gaps.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, "..", "tools");
const RECORD = join(HERE, "fixtures", "record");
const REQUIREMENTS = join(RECORD, "inception", "requirements-analysis", "requirements.md");
const STORIES = join(RECORD, "inception", "user-stories", "stories.md");
const STORY_MAP = join(RECORD, "inception", "units-generation", "unit-of-work-story-map.md");
const BANDS = { flag: 0.7, unsure: 0.3, block: 0.9 };
const GAPS = join(HERE, "fixtures", "gaps");
const gapDoc = (name: string) =>
	join(GAPS, name, "inception", "requirements-analysis", "requirements.md");

interface SensorRun {
	status: number | null;
	json: Record<string, unknown> | null;
	stderr: string;
}

function runSensor(
	sensor: "jev-quality" | "jev-blocking" | "jev-gaps",
	file: string,
	env: Record<string, string | undefined>,
): SensorRun {
	const result = spawnSync(
		process.execPath,
		[join(TOOLS, `aidlc-sensor-${sensor}.ts`), "--stage", "test", "--output-path", file],
		{ encoding: "utf-8", env: { ...process.env, ...env } as Record<string, string> },
	);
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(result.stdout.trim());
	} catch {
		// Non-JSON stdout (tool-unavailable exits) is asserted by the caller.
	}
	return { status: result.status, json, stderr: result.stderr };
}

describe("document splitting", () => {
	const requirements = readFileSync(REQUIREMENTS, "utf-8");
	const stories = readFileSync(STORIES, "utf-8");

	test("finds each requirement once, with its section", () => {
		const items = splitItems(requirements, "requirement");
		expect(items.map((item) => item.id)).toEqual([
			"FR1", "FR2", "FR3", "FR4", "FR5", "FR6", "FR7", "FR8", "NFR1", "NFR2", "NFR3",
		]);
		expect(items[0].section).toBe("Functional Requirements");
		expect(items[8].section).toBe("Non-Functional Requirements");
	});

	test("a requirement cited inside a story stays part of the story", () => {
		const items = splitItems(stories, "story");
		expect(items.map((item) => item.id)).toEqual(["US1.1", "US1.2", "US1.3", "US1.4"]);
		const us11 = items.find((item) => item.id === "US1.1");
		expect(us11?.text).toContain("FR1 (traces to)");
		expect(us11?.text).toContain("AC1.1.2");
	});

	test("a long divider line splits in linear time", () => {
		const body = `## Functional\n${"-".repeat(5000)}\n- **FR1** Users can pre-order.\n`;
		const started = performance.now();
		const items = splitItems(body, "requirement");
		expect(performance.now() - started).toBeLessThan(100);
		expect(items.map((item) => item.id)).toEqual(["FR1"]);
	});

	test("protocol sections are not judged", () => {
		const headings = splitSections(requirements).map((section) => section.id);
		expect(headings).toContain("Out of Scope");
		expect(headings).not.toContain("Sources");
	});
});

describe("banding", () => {
	test("probability of a bad answer maps to flagged, unsure, fine", () => {
		expect(band(0.95, BANDS)).toBe("flagged");
		expect(band(0.5, BANDS)).toBe("unsure");
		expect(band(0.1, BANDS)).toBe("fine");
	});

	test("a Score sums every level below the top", () => {
		const judged = judgeScore(
			{ type: "score", score: 0.8, confidence: 0.3, probabilities: { "0": 0.45, "1": 0.3, "2": 0.25 } },
			["no success condition", "vague"],
			BANDS,
		);
		expect(judged.band).toBe("flagged");
		expect(judged.label).toBe("no success condition");
		expect(judged.pBad).toBeCloseTo(0.75);
	});

	test("a Noul's bad direction is configurable", () => {
		expect(judgeNoul({ type: "noul", noul: 0.9 }, true, "compound", BANDS).band).toBe("flagged");
		expect(judgeNoul({ type: "noul", noul: 0.9 }, false, "actor absent", BANDS).band).toBe("fine");
	});
});

describe("without an API key", () => {
	const noKey = { TYPESAFE_API_KEY: undefined };

	test("the advisory check reports tool-unavailable", () => {
		const run = runSensor("jev-quality", REQUIREMENTS, noKey);
		expect(run.status).toBe(127);
	});

	test("the blocking check still enforces its code checks and says Jev was not called", () => {
		const run = runSensor("jev-blocking", REQUIREMENTS, noKey);
		expect(run.status).toBe(0);
		expect(run.json?.pass).toBe(false);
		expect(run.json?.findings).toEqual([
			'Functional Requirements: filled → placeholder "TBD" (code)',
			'Out of Scope: filled → placeholder "TBD" (code)',
		]);
		expect(String(run.json?.note)).toContain("TYPESAFE_API_KEY is not set");
	});

	test("stories missing acceptance criteria block", () => {
		const run = runSensor("jev-blocking", STORIES, noKey);
		expect(run.json?.findings).toEqual([
			"US1.2: ac_format → missing (code)",
			"US1.4: ac_format → missing (code)",
		]);
	});

	test("IDs in a story map are references, not items to judge", () => {
		const run = runSensor("jev-blocking", STORY_MAP, noKey);
		expect(run.json?.pass).toBe(true);
	});

	test("an unreachable API fails open with a note", () => {
		const run = runSensor("jev-blocking", REQUIREMENTS, {
			TYPESAFE_API_KEY: "test-key",
			TYPESAFE_BASE_URL: "http://127.0.0.1:9",
		});
		expect(run.status).toBe(0);
		expect(String(run.json?.note)).toContain("Jev unavailable");
	});
});

describe("gap checklist", () => {
	test("a gap needs the concern to be relevant and unaddressed", () => {
		const bands = { flag: 0.5, unsure: 0.4, block: 1 };
		expect(judgeGap("ownership", 0.75, 0.2, bands).band).toBe("flagged");
		expect(judgeGap("offline", 0.5, 0.1, bands).band).toBe("unsure");
		// Relevant but addressed, or unaddressed but irrelevant: no gap.
		expect(judgeGap("concurrency", 0.9, 0.97, bands).band).toBe("fine");
		expect(judgeGap("pagination", 0.05, 0.05, bands).band).toBe("fine");
	});

	test("relevance is the probability of the top Score level", () => {
		expect(
			topLevel({ type: "score", score: 0.7, confidence: 0.5, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 } }),
		).toBeCloseTo(0.6);
	});

	test("Jev sees requirement lines and the other sections, not protocol ones", () => {
		const { requirements, decisions } = buildState(readFileSync(gapDoc("bakery"), "utf-8"));
		expect(requirements).toHaveLength(8);
		expect(requirements[0]).toStartWith("- **FR1**");
		expect(Object.keys(decisions)).toEqual([
			"Intent Analysis",
			"Constraints",
			"Assumptions",
			"Out of Scope",
			"Open Questions",
		]);
	});

	test("the default checklist has unique snake_case ids", () => {
		const ids = DEFAULT_CHECKLIST.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
	});

	test("a project checklist replaces the default, and a malformed one is refused", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-gaps-"));
		const good = join(dir, "good.json");
		const bad = join(dir, "bad.json");
		writeFileSync(good, JSON.stringify([{ id: "allergens", concern: "Allergen information for each item." }]));
		writeFileSync(bad, JSON.stringify([{ id: "Allergens", concern: "" }]));
		const saved = process.env.JEV_GAPS_CHECKLIST;
		try {
			process.env.JEV_GAPS_CHECKLIST = good;
			expect(loadChecklist().map((c) => c.id)).toEqual(["allergens"]);
			process.env.JEV_GAPS_CHECKLIST = bad;
			expect(() => loadChecklist()).toThrow("expected a non-empty JSON array");
		} finally {
			if (saved === undefined) delete process.env.JEV_GAPS_CHECKLIST;
			else process.env.JEV_GAPS_CHECKLIST = saved;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("without an API key it reports tool-unavailable", () => {
		const run = runSensor("jev-gaps", gapDoc("bakery"), { TYPESAFE_API_KEY: "" });
		expect(run.status).toBe(127);
	});

	test("documents other than requirements.md are skipped", () => {
		const run = runSensor("jev-gaps", STORIES, { TYPESAFE_API_KEY: "" });
		expect(run.status).toBe(0);
		expect(run.json?.skipped).toBe(true);
	});

	test("an unreachable API is a script error", () => {
		const run = runSensor("jev-gaps", gapDoc("bakery"), {
			TYPESAFE_API_KEY: "test-key",
			TYPESAFE_BASE_URL: "http://127.0.0.1:9",
		});
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("jev-gaps:");
	});
});

const live = process.env.JEV_LIVE === "1" && Boolean(process.env.TYPESAFE_API_KEY);

describe.if(live)("live: labelled sample", () => {
	test("both checks together match the labels", () => {
		const expected = readFileSync(join(HERE, "fixtures", "expected.tsv"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => line.split("\t"));
		const flagged = new Set<string>();
		for (const file of [REQUIREMENTS, STORIES]) {
			for (const sensor of ["jev-quality", "jev-blocking"] as const) {
				const run = runSensor(sensor, file, {});
				expect(run.status).toBe(0);
				for (const finding of (run.json?.findings as string[]) ?? []) {
					const match = /^(?:unsure: )?(.+?): (\w+) → /.exec(finding);
					if (match && !finding.startsWith("unsure: ")) flagged.add(`${match[1]}|${match[2]}`);
				}
			}
		}
		const wrong = expected.filter(
			([item, check, bad]) => flagged.has(`${item}|${check}`) !== (bad === "1"),
		);
		// Jev's probabilities vary slightly between calls; allow one miss at
		// the threshold, never a pattern of them.
		expect(wrong.length).toBeLessThanOrEqual(1);
	}, 180_000);
});

describe.if(live)("live: labelled gap documents", () => {
	// Each document's reviewed gaps must be flagged; concerns a reviewer would
	// never raise for it must not be. Concerns in neither list are left to
	// judgment, since reviewers disagree on them.
	const cases: Record<string, { gaps: string[]; never: string[] }> = {
		bakery: {
			gaps: ["ownership"],
			never: ["pagination", "localisation", "export_import", "concurrency", "reference_data"],
		},
		"bakery-fixed": {
			gaps: [],
			never: ["ownership", "access_control", "pagination", "localisation", "export_import"],
		},
		inspection: {
			gaps: ["offline"],
			never: ["ownership", "notifications", "retention", "pagination", "localisation"],
		},
	};
	for (const [name, expected] of Object.entries(cases)) {
		test(name, () => {
			const run = runSensor("jev-gaps", gapDoc(name), {});
			expect(run.status).toBe(0);
			const flagged = ((run.json?.findings as string[]) ?? [])
				.filter((f) => !f.startsWith("unsure: "))
				.map((f) => f.split(":")[0]);
			const reported = ((run.json?.findings as string[]) ?? []).map((f) =>
				f.replace(/^unsure: /, "").split(":")[0],
			);
			for (const gap of expected.gaps) expect(flagged).toContain(gap);
			for (const id of expected.never) expect(reported).not.toContain(id);
		}, 120_000);
	}
});
