// The jev plugin's own tests.
//
// Offline tests always run: document splitting, banding, and how both sensor
// modes behave without an API key. The live test runs the labelled bakery
// sample through the real Jev API and only runs when JEV_LIVE=1 and
// TYPESAFE_API_KEY are set (it sends the fixture text to TypeSafe or the
// configured TYPESAFE_BASE_URL).
//
// Run: bun test tests/

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	band,
	judgeNoul,
	judgeScore,
	splitItems,
	splitSections,
} from "../tools/aidlc-sensor-jev-quality.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(HERE, "..", "tools");
const RECORD = join(HERE, "fixtures", "record");
const REQUIREMENTS = join(RECORD, "inception", "requirements-analysis", "requirements.md");
const STORIES = join(RECORD, "inception", "user-stories", "stories.md");
const STORY_MAP = join(RECORD, "inception", "units-generation", "unit-of-work-story-map.md");
const BANDS = { flag: 0.7, unsure: 0.3, block: 0.9 };

interface SensorRun {
	status: number | null;
	json: Record<string, unknown> | null;
	stderr: string;
}

function runSensor(
	sensor: "jev-quality" | "jev-blocking",
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
