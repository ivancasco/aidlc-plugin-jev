// aidlc-sensor-jev-blocking.ts — blocking gate sensor for serious, near-certain
// planning-document problems. The checks live in aidlc-sensor-jev-quality.ts;
// this entry point runs them in blocking mode (the sensor dispatcher requires
// one aidlc-sensor-<id>.ts script per sensor id).

import { main as runJevQuality } from "./aidlc-sensor-jev-quality.ts";

export function main(argv: string[]): Promise<void> {
	return runJevQuality([...argv, "--mode", "blocking"]);
}

if (import.meta.main) await main(process.argv.slice(2));
