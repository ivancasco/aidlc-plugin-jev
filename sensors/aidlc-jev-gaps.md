---
id: jev-gaps
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-jev-gaps.ts
default_severity: advisory
fire_on: gate
description: Checks a requirements document against a fixed checklist of concerns (ownership, reference data, access control, validation, retention and more) and uses TypeSafe's Jev classifier to report the ones that matter for the intent but are never addressed
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
  concerns: object
timeout_seconds: 90
---

# jev-gaps sensor

Runs at the Requirements Analysis approval gate, on `requirements.md` only.
Advisory: it reports, it never blocks.

Jev is a classifier, so it is never asked what is missing. The checklist is
supplied by code: AI-DLC's requirements completeness checklist
(`knowledge/aidlc-product-agent/requirements-guide.md`), plus two concerns
reviews keep catching, who a record belongs to and where reference data comes
from, and one for record lifecycle (expiry, cancellation, no-shows).

For each concern, one request asks Jev two questions:

| Question | Type | Asks |
|---|---|---|
| `addressed` | Noul | Do the requirements or the other sections (constraints, assumptions, out of scope, open questions) deal with it, even only to exclude it? |
| `relevant` | Score, 3 levels | Does the product described in the intent statement depend on a decision about it: not at its stated size · good practice only · its main flow depends on it |

A gap is a concern that is relevant and not addressed:
`P(gap) = P(top relevance level) × P(not addressed)`. It is **flagged** at or
above `JEV_GAPS_FLAG` and **unsure** at or above `JEV_GAPS_UNSURE`. The
relevance question keeps a proof of concept from being told it lacks
pagination or localisation. A concern that is addressed is not checked for
quality; `jev-quality` judges each requirement.

State per request: the intent statement (or, without one, the document's
intent analysis), the requirement lines, and every other non-protocol section
by heading. Never the raw document.

## Configuration

- `TYPESAFE_API_KEY` (required). Without it the sensor reports
  `tool-unavailable` and passes.
- `TYPESAFE_BASE_URL`, `JEV_MODEL`: as `jev-quality`.
- `JEV_GAPS_FLAG` (optional, default `0.5`) and `JEV_GAPS_UNSURE` (optional,
  default `0.4`). Calibrated on the three labelled documents in
  `tests/fixtures/gaps/`; tune them against your own reviews.
- `JEV_GAPS_CHECKLIST` (optional): path to a JSON array of
  `{"id": "snake_case", "concern": "one sentence"}` that replaces the default
  checklist, for a domain with its own recurring concerns.

## Failure mode

Emits `SENSOR_FAILED` with one finding per flagged or unsure concern
(`ownership: not addressed (p=0.59; relevant 0.73, addressed 0.19)`,
`unsure: offline: …`) and the per-concern probabilities in `concerns`, in the
detail file under the active record's `.aidlc-engine/sensors/<stage-slug>/`.
API or network errors are recorded as `script-error` and pass.
