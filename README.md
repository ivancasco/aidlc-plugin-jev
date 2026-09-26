# jev — Jev document-quality checks for AI-DLC

An [AI-DLC](https://github.com/awslabs/aidlc-workflows) plugin that adds two
approval-gate checks to the planning stages, using
[TypeSafe's Jev](https://docs.typesafe.ai) classifier. Jev returns typed
judgments with calibrated probabilities instead of text, so the checks can
score a document piece by piece without asking a large model to read it.

| Check | Severity | What it reports |
|---|---|---|
| `jev-quality` | advisory | Per requirement: measurable success condition, bundled requirements, on-topic with the intent statement. Per story: actor, action and value present; Given/When/Then acceptance criteria. Per section: specific content rather than generic filler. Each result is flagged, unsure (for a person to look at) or fine. |
| `jev-blocking` | blocking | Only serious, near-certain problems: a requirement with no success condition (probability ≥ 0.9), a story with no acceptance criteria, an empty or TBD section. The gate stays closed until the problem is fixed or a person records an override. |

Both run when these stages open their approval gate: Intent Capture, Scope
Definition, Requirements Analysis, User Stories, Units Generation and Delivery
Planning. Requirement checks run only on `requirements.md` and story checks
only on `stories.md`; elsewhere those IDs are references, so only sections are
checked.

## How it works

Jev is a small-context classifier, not a reasoning model, so the checks never
send it a whole document:

- Code splits each document into requirements, stories and sections, and
  handles anything a pattern can decide (Given/When/Then, the
  "As a … I want … so that" form, empty and TBD sections).
- Each piece goes to Jev as one request with named fields
  (`project_intent`, `document_type`, `section`, `item`) and every question
  about that piece asked together.
- Graded judgments use Score questions and yes/no conditions use Noul
  questions, with boundary cases written into the criteria.
- Code decides from the answer probabilities; scores such as
  `measurable 7/8` are counted in code, never by the model.

It checks the quality of what is written. It cannot see what a document
leaves out; that stays with the reviewer.

## Install

Requires AI-DLC 2.10 or later.

Build the host projection with the AI-DLC plugin tools, then install it through
your harness's plugin mechanism (see the AI-DLC plugin guide):

```bash
bun <aidlc-tools-dir>/aidlc-plugin-validate.ts jev
bun <aidlc-tools-dir>/aidlc-plugin-build.ts jev claude
```

Check the install with `/aidlc --doctor`: it confirms the plugin's files are
composed and warns when no API key is set.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | (required) | TypeSafe API key, or an OpenRouter key when using OpenRouter |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Set to `https://openrouter.ai/api` to use OpenRouter |
| `JEV_MODEL` | `jev-1.13` | `typesafe/jev-1.13` on OpenRouter |
| `JEV_FLAG` | `0.7` | Probability of a bad answer that flags |
| `JEV_UNSURE` | `0.3` | Probability of a bad answer that marks a piece as unsure |
| `JEV_BLOCK` | `0.9` | Probability of "no success condition" that blocks |

The variables must be visible to the environment AI-DLC's hooks run in.

The default thresholds were tuned on the small labelled sample in
`tests/fixtures/`. Check them against your own documents before relying on
the blocking check.

## Without a key, or when the API is down

`jev-quality` reports that it could not run and passes. `jev-blocking` still
enforces its code checks (missing acceptance criteria, empty or TBD sections),
skips the Jev check, passes, and says why in its result. No approval gate is
held up by a missing key or an outage.

## Data handling

Enabling this plugin sends planning-document text (requirements, stories,
section bodies and a short excerpt of the intent statement) to TypeSafe, or to
OpenRouter if configured. Do not enable it for documents you cannot share with
that provider.

## Seeing the results

Blocking results always stop the gate and show their findings. Advisory
results reach the approval question once AI-DLC shows advisory gate-sensor
results there (proposed upstream as `sensor_notices`); on earlier versions
they are recorded in the audit log and the detail files under
`<record>/.aidlc-engine/sensors/<stage>/`.

## Tests

```bash
bun test tests/                  # offline tests
JEV_LIVE=1 bun test tests/       # also runs the labelled sample through the API
```

CI runs the offline tests, the compose test for every harness, and (on
`main`, manually and weekly) the live sample when the `TYPESAFE_API_KEY`
repository secret is set. Codex is allowed to fail until AI-DLC fixes its
Codex compose hook.

## Development

Tool versions (bun, prek, pinact) live in `mise.toml`, with checksums pinned
in `mise.lock`. CI installs them the same way through `jdx/mise-action`.

```bash
mise install                      # bun, prek and pinact at the pinned versions
mise run test                     # offline tests
GITHUB_TOKEN=$(gh auth token) mise run lint     # all prek hooks
mise run compose -- claude 2.10.0 # compose-test one harness (needs gh)
mise exec -- prek install         # run the hooks before each commit
```

Hooks: actionlint, zizmor, shellcheck, gitleaks, pinact and basic file checks.
Actions are pinned to commit SHAs with verified version comments. Update them
with `mise exec -- pinact run -u`; `.pinact.yaml` and Dependabot both hold
back releases younger than 7 days.

## License

MIT. See [LICENSE](LICENSE).
