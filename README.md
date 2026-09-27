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

Requires AI-DLC 2.10 or later, installed in the project.

Each release publishes the plugin built for every AI-DLC harness to its own
branch of this repository, with the host's plugin manifest and marketplace
file at the branch root: `claude`, `codex`, `copilot`, `cursor`, `kiro`,
`kiro-ide` and `opencode`. The branch always holds the latest release; a tag
`vX.Y.Z-<harness>` (for example `v0.2.0-claude`) holds one release. `main` has
the source only and cannot be installed directly. The marketplace is named
`aidlc-plugins` and the plugin `aidlc-jev`.

**Claude Code.** In a session:

```text
/plugin marketplace add ivancasco/aidlc-plugin-jev#claude
/plugin install aidlc-jev@aidlc-plugins
```

or from a shell, `claude plugin marketplace add ivancasco/aidlc-plugin-jev#claude`
then `claude plugin install aidlc-jev@aidlc-plugins`. Add `--scope project` to
both to record them in the project's `.claude/settings.json` for everyone who
works in it. Use `#v0.2.0-claude` instead of `#claude` to stay on one release.

**Codex CLI.**

```bash
codex plugin marketplace add ivancasco/aidlc-plugin-jev --ref codex
codex plugin add aidlc-jev@aidlc-plugins
```

`--ref v0.2.0-codex` pins one release. AI-DLC 2.10.0's Codex compose hook
fails its own idempotency check (see [Tests](#tests)), so the Codex install is
not yet expected to compose cleanly.

**Kiro and Kiro IDE.** Kiro has no plugin store. Copy the build into the
project and run the composer, as the AI-DLC plugin guide describes. Use the
`kiro-ide` branch for Kiro IDE 1.x and Kiro CLI v3 (it registers a
SessionStart compose hook), `kiro` otherwise:

```bash
git clone --depth 1 --branch kiro-ide https://github.com/ivancasco/aidlc-plugin-jev.git /tmp/jev
rm -rf /tmp/jev/.git /tmp/jev/README.md   # keep your project's README
cp -R /tmp/jev/. <project>/
AIDLC_PLUGIN_ROOT=/tmp/jev AIDLC_PROJECT_DIR=<project> \
  AIDLC_HARNESS_DIR=.kiro aidlc engine plugin sync
```

**Copilot, Cursor, opencode.** The `copilot`, `cursor` and `opencode` branches
hold those builds; install them with the harness's own plugin mechanism, as the
[AI-DLC plugin guide](https://github.com/awslabs/aidlc-workflows) describes.

Check the install with `/aidlc --doctor`: it confirms the plugin's files are
composed and warns when no API key is set.

To build the projections yourself, run `scripts/build-dist.sh <out-dir>`
(needs bun and an authenticated `gh`): it writes `<out-dir>/<harness>/` for
every harness with the plugin tools of an official AI-DLC release.

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
