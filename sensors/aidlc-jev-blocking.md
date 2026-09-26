---
id: jev-blocking
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-jev-blocking.ts
default_severity: blocking
fire_on: gate
description: Blocks approval on serious, near-certain planning-document problems (requirement with no success condition, story with no acceptance criteria, empty or TBD section)
category: document-quality
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings: string[]
  findings_count: integer
  note: string
timeout_seconds: 90
---

# jev-blocking sensor

The blocking half of the Jev document-quality check; `jev-quality` is the
advisory half. Both run the same script
(`aidlc-sensor-jev-quality.ts`, here with `--mode blocking`). Code findings
(empty or TBD sections, missing acceptance criteria) are reported only here. A
"no success condition" finding is always reported by `jev-quality` too: Jev's
probabilities vary slightly between calls, so splitting on them could drop a
borderline finding from both checks.

It blocks the approval gate only on problems that are serious and near-certain:

| Piece | Blocks when | How |
|---|---|---|
| Requirement (`FR{n}`, `NFR{n}`, in `requirements.md`) | No success condition, with probability at or above `JEV_BLOCK` (default `0.9`) | Jev Score |
| Story (`US{g}.{s}`, in `stories.md`) | No acceptance criteria at all | Code |
| Each `##` section | Empty, or a TBD/TODO/placeholder marker | Code |

A blocked gate stays closed until the findings are fixed, or a person chooses
**Override blocking sensors**, which is recorded in the audit log. Autonomous
runs cannot override.

## Failing open on purpose

A blocking gate normally treats "could not evaluate" as a failure. This check
does not: without `TYPESAFE_API_KEY`, or when the Jev API is unreachable, it
still runs its code checks, skips the Jev check, reports a pass, and records
why in `note`. Teams without a key, or during an outage, are not stopped at
every approval point.

## Configuration

Shares `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` and `JEV_MODEL` with
`jev-quality`, plus `JEV_BLOCK` (probability of "no success condition" that
blocks; default `0.9`).
