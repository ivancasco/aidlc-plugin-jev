// jev-doctor.ts — /aidlc --doctor checks for the jev plugin.
//
// Deterministic and read-only: confirm the composed install carries the
// plugin's sensors and scripts, and say whether the Jev API is configured.
// Emits the plugin doctor JSON contract on stdout.

import { existsSync } from "node:fs";
import { join } from "node:path";

const projectDir = process.env.AIDLC_PROJECT_DIR ?? process.cwd();
const harnessDir = process.env.AIDLC_HARNESS_DIR ?? ".claude";
const harnessRoot = join(projectDir, harnessDir);
const syncFix = `Run \`bun ${harnessDir}/tools/aidlc-utility.ts plugin-sync\` (or re-run the plugin's \`hooks/compose.ts\`).`;

function installed(relativePath: string) {
	return {
		pass: existsSync(join(harnessRoot, relativePath)),
		label: `${relativePath} installed`,
		fix: syncFix,
		severity: "error" as const,
	};
}

const checks = [
	installed("sensors/aidlc-jev-quality.md"),
	installed("sensors/aidlc-jev-blocking.md"),
	installed("tools/aidlc-sensor-jev-quality.ts"),
	installed("tools/aidlc-sensor-jev-blocking.ts"),
	installed("sensors/aidlc-jev-gaps.md"),
	installed("tools/aidlc-sensor-jev-gaps.ts"),
	{
		// Advisory: without a key jev-quality and jev-gaps report
		// tool-unavailable and jev-blocking runs only its code checks. All
		// three still pass.
		pass: Boolean(process.env.TYPESAFE_API_KEY),
		label: "TYPESAFE_API_KEY set (Jev checks call the API)",
		fix: "Set TYPESAFE_API_KEY in the environment AI-DLC hooks run in (a TypeSafe key, or an OpenRouter key with TYPESAFE_BASE_URL=https://openrouter.ai/api and JEV_MODEL=typesafe/jev-1.13).",
		severity: "advisory" as const,
	},
];

process.stdout.write(`${JSON.stringify({ checks })}\n`);
