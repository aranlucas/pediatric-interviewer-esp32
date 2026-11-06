# Untangle decision log — 2026-11-06

Scope: all first-party firmware, simulator, Worker, web, tooling, tests and configuration.
Baseline: f60d934; clean checkout. Preserve the documentation and test-pruning decisions
in #72 and #73. Both comment and test additions are selected. Validation is CI-only;
no local tests, benchmarks, browser tests or builds will run. No owned test processes
were present at inventory time. Physical board behavior remains unvalidated.

## Inventory and design before edits

- Put browser/Worker interview contract values in a dependency-free shared module.
  - `web/lib/interview.ts` duplicates question defaults/limits, difficulty IDs and
    defaults from `worker/src/interview-config.ts`.
  - Status literals are independently maintained in the browser type, browser Zod
    schema and Worker protocol type.
  - Browser topic IDs and Worker clinical topic IDs must agree. Keep browser copy
    and clinical blueprint detail separate, but make their coverage type-checked.
  - The shared module must not import React, Next, Cloudflare, provider SDKs or
    Worker prompts. Existing package dependencies suffice; no new libraries.
- Remove the obsolete opening-mode argument from turn completion.
  - `turn-completion.ts` discards `openingInProgress`; all phases need the definitive
    provider `turnComplete` signal. Callers should not supply irrelevant workflow state.
  - Tests repeat the same contract for both booleans, including a misleading test
    title claiming generationComplete is accepted. Retain one meaningful contract
    test that catches early playback truncation.
- Keep necessary platform boundaries and compatibility cases.
  - Firmware C++ and simulator fixtures model different hardware; do not rewrite
    vendor submodules, generated assets or replace explicit platform glue.
  - Durable session migration, reconnect epochs, bounded retries, socket grace,
    provider timeouts and speech fallback protect observed transport behavior.
  - Private and public report stores have different privacy contracts. Do not merge
    authorization and publication flows merely because their key shapes look alike.
  - Token implementations differ in accepted scopes, bounds and validation. Avoid
    changing the credential acceptance contract as incidental refactoring.
  - Clinical prompts and UI topic copy intentionally differ. Preserve both.
- Review comments and tests after structural changes, preserving external constraints,
  regression tests and recent pruning. Do not split large lifecycle owners purely
  to reduce file size: their state transitions must remain coordinated.

CI already runs both package behavioral suites, static checks, formatting, web build
and Worker deployment dry runs on PRs. It requires no credentials for live providers.
Further inventory/review findings and validation results are appended below.

## Inventory review additions (before their edits)

- Remove the firmware's undocumented `waveshare_touch_demo/cloudflare_config.h`
  fallback. Configuration must come from this checkout's explicit local header;
  missing configuration remains safe and simulator credential isolation stays intact.
- Remove `audio-buffer-model.mjs` and its live-suite gate. It executes an independent
  queue model with a stale 24 KiB prebuffer rather than the firmware's 48 KiB queue;
  it cannot fail on a firmware regression. Keep real framing, transcript, turn and
  report checks and clearly exclude firmware buffering from host-suite claims.
- Derive Gemini evaluation/cheatsheet response schemas from existing Zod schemas.
  Preserve omission of runtime-owned followUps, string-length constraints enforced
  by local validation, and exact per-interview exchange counts. Google's structured
  output documentation describes a JSON Schema subset; Zod's native override API
  permits preserving the existing provider projection without repeating its fields.
  References: https://ai.google.dev/gemini-api/docs/structured-output and
  https://zod.dev/json-schema#override .
- Centralize private report object keys in a Worker-local artifact module, consumed
  by both writer and HTTP reader. Keep the independently published public archive.
- Repair the opt-in live browser smoke fixture: request a server-generated room,
  inspect cookies individually, and verify owner-scoped refresh instead of assuming
  arbitrary room creation. Existing README explicitly records this baseline defect.
  Its live provider interaction stays opt-in; ordinary mocked session tests run in CI.

Inventory reviewer examined all first-party areas and identified no reason for
arbitrary class splits or new dependencies. Keep known-answer token fixtures,
transport lifecycle regressions and meaningful privacy/audio checks.

## Implementation and validation plan

Implemented the inventory fixes. The shared contract contains only domain IDs and
wire values; browser display copy and Worker clinical content stay in their owners,
with exhaustive typed records against the shared topic IDs. No dependencies or
custom scripts were added. The provider request regression test now protects its
required exchange fields, skill values and 1–3 scoring range as well as actual
answered-question count; accidental omission during schema projection would break it.
The obsolete opening-mode predicate tests became one turn-boundary contract test.

Baseline evidence: the two most recent completed main CI runs inspected were green
at 2ddd4f2 (#73). This checkout starts at the newer dependency update f60d934; its
CI status is not inferred from those earlier runs. No local behavioral validation
was run. Dependency installation used --ignore-scripts; only formatting and
`git diff --check` have been run locally. PR CI must establish the current result.
The live smoke fixture is repaired by static review, not claimed live-validated.

## Implementation review

A sequential independent reviewer found two remaining links: UI difficulty options
could omit a valid difficulty, and package-scoped lint skipped the new shared folder.
Both are fixed: difficulty presentation uses an exhaustive record mapped from the
shared IDs; PR CI explicitly lints the shared contract. The reviewer found no runtime
regressions in schema projection, artifact naming, topic coverage, smoke repair or
playback-model removal. Final re-review requested after these fixes.

Final independent static re-review found no issues worth fixing. All inventory
items are addressed or retained with reasons above. Local shared-contract lint
identified spacing only; fixed before submission. Behavioral suites, package
checks and deployment dry runs remain CI-only. No live service or board validation
is claimed. PR delivery now proceeds under the user's authorized merge policy.

## CI follow-up

Run 42262390909 passed all 114 Worker and 79 web tests, then failed lint on
introduced spacing, inline presentation types and a redundant schema type union.
These are corrected without altering runtime behavior or weakening tests. Tests
remain CI-only; the next head must pass the complete CI pipeline before merge.
