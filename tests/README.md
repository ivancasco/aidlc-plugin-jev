# Plugin tests

Keep plugin tests and fixtures under this directory. Do not place them under
`tools/`: composition copies `tools/` recursively into every install, so
test payloads there become shipped runtime files.

- `jev.test.ts`: offline tests (document splitting, banding, behaviour without
  a key or with the API down) and an opt-in live test.
- `fixtures/record/`: a small bakery pre-order record with deliberately weak
  and strong requirements and stories.
- `fixtures/expected.tsv`: the hand-written label for each item and check
  (`1` = should be flagged). The live test allows one mismatch, because Jev's
  probabilities vary slightly between calls near the thresholds.

```bash
bun test tests/                  # offline
JEV_LIVE=1 bun test tests/       # live, needs TYPESAFE_API_KEY
```
