---
id: jev-quality
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-jev-quality.ts
default_severity: advisory
fire_on: gate
description: Checks planning documents piece by piece, with code for text patterns and TypeSafe's Jev classifier for judgments (measurability, bundled requirements, story parts, section completeness, on-topic with intent)
category: document-quality
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  scores: object
  findings: string[]
  findings_count: integer
  flagged_count: integer
  unsure_count: integer
timeout_seconds: 90
---

# jev-quality sensor

Runs at the approval gate of the planning stages (intent capture, scope
definition, requirements analysis, user stories, units generation, delivery
planning), once per deliverable. Advisory: it reports, it never blocks.

Jev is a small-context classifier, not a reasoning model, so the script never
sends it a whole document. It splits each deliverable in code, checks text
patterns in code, and sends Jev one request per piece with every question about
that piece asked together. State is a named-field object
(`document_type`, `section`, `item`, `project_intent`).

This is the advisory half of the Jev check; `jev-blocking` is the blocking
half and runs the same script with `--mode blocking`. Empty or TBD sections and
stories with no acceptance criteria are reported only by `jev-blocking`.

Requirement checks run only on `requirements.md` and story checks only on
`stories.md`. In every other deliverable (story maps, delivery plans) those IDs
are references, so only its sections are checked. Inside a story, a cited
`FR`/`NFR` ID stays part of the story's text.

| Piece | Check | How | Flagged as |
|---|---|---|---|
| Requirement (`FR{n}`, `NFR{n}`) | `measurable` | Jev Score, 3 levels | no success condition · vague |
| Requirement | `compound` | Jev Noul | compound |
| Story (`US{g}.{s}`) | `actor`, `action`, `value` | Code (`As a … I want … so that`), Jev Noul when the story departs from it | absent |
| Story | `ac_format` | Code (Given / When / Then) | missing · not given-when-then |
| Requirement or story | `on_topic` vs intent statement | Jev Score, 3 levels | unrelated · tangential |
| Each `##` section | `filled` | Code for empty and TBD/TODO, Jev Noul otherwise | empty · placeholder · generic |

Each judgment is banded from the probability of a bad answer (the sum over
the lower Score levels, or the Noul probability in the bad direction):
**flagged** at or above `JEV_FLAG`, **unsure** at or above `JEV_UNSURE`,
otherwise fine. Unsure pieces are listed for a person to look at. Scores are
counted by the script (for example `measurable: 5/11`), never by the model.
Protocol sections (`Sources`, `Assumptions & Open Questions`,
`Assumption Confirmation`, `Review`, `Positions`), questions files and the
stage diary are skipped.

## Configuration

- `TYPESAFE_API_KEY` (required). Without it the sensor reports
  `tool-unavailable` and passes.
- `TYPESAFE_BASE_URL` (optional, default `https://api.typesafe.ai`). Set it to
  `https://openrouter.ai/api` to use OpenRouter's TypeSafe-compatible endpoint.
- `JEV_MODEL` (optional, default `jev-1.13`; `typesafe/jev-1.13` on OpenRouter).
- `JEV_FLAG` (optional, default `0.7`) and `JEV_UNSURE` (optional, default
  `0.3`). Starting points, to be tuned against labelled examples from real runs.

`429` and `529` responses are retried with exponential backoff, honouring
`retry-after`.

## Failure mode

Emits `SENSOR_FAILED` with the scores and one finding per flagged or unsure
piece (`FR2: measurable → vague (p=1)`, `unsure: FR4: on_topic → tangential
(p=0.64)`, `Out of Scope: filled → placeholder "TBD" (code)`) in the detail
file under the active record's `.aidlc-engine/sensors/<stage-slug>/`. API or
network errors are recorded as `script-error` and pass.
