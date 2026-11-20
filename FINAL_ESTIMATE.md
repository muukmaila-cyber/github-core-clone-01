# Final estimate — github-core-clone-01 (forge v0.2, commit 5333a8e)

This is a synthetic estimate from independent practice runs, NOT an official
final score. The final runs three hidden instances drawn after the deadline
(drand round 34146612); nobody can know them in advance. A prize also needs
beating the house reference forge (calibration: 120/120 checks, perf 100,
~900/1000) with the 90% paired t-interval of the per-instance lead strictly
above 0.

## Measured results (grade-local, --driver process, official kit)

| run | trial 0 | trial 1 | trial 2 | mean |
|---|---|---|---|---|
| v0.1 single | 958 | — | — | 958 |
| v0.2 single | 964 | — | — | 964 |
| v0.2 3-trial | 972 | 964 | 964 | 966.7 |

- Feature: 600/600 on every run (120/120 conformance checks).
- Agent (MCP): 200/200 on every run (15/15 checks).
- Perf: 158 (v0.1) -> 164-172 (v0.2); per-workload points in the 3-trial run
  are not exported per trial, but the single-trial v0.2 split was
  push 37, clone 37, read 50, write 40.

## Estimate statistics (v0.2, 3 practice trials + 1 single-trial run)

- Mean estimated score: ~966
- Median: 964
- Minimum: 964
- Maximum: 972
- Variation: perf p50 varies ~8% run to run (push rounds within one run
  spanned 734-890 ms); feature and agent columns are stable at maximum.
- Feature reliability: 120/120 on 4/4 runs.
- MCP reliability: 15/15 on 4/4 runs.
- Determinism status: 0 nondeterministic trials in every run; replay check
  passed (state export matched on replay). The store uses a logical clock
  (no wall clock, no Math.random) and sequential ids, so identical request
  order yields identical state.

## What could still lose points on the hidden instances

1. Perf variance. The score's only moving part is perf (feature/agent are
   maxed). Push and write sit ~10 points below their ceiling and move
   +/-2 points between runs from CPU contention alone. A slow final
   instance could cost ~5-10 points vs the estimate.
2. Unseen fixture shapes. The conformance suite is fixed, but hidden
   instances use different seeded names/bytes. The entry derives the viewer
   identity from the fixed scenario seed (verified against the real
   buildScenario() output) and handles every documented shape generically;
   no check depends on a practice-only name or value.
3. Concurrency. The clone workload fires 50 concurrent fetches; the entry
   is single-threaded and its fetch-pack cache makes repeats cheap, but a
   much slower final host would hurt all four workloads proportionally.
4. The house baseline. House is ~900 with full correctness; this entry is
   ~65 points above it on practice. The prize test is a paired comparison,
   so the lead is what matters, not the absolute score — and the lead is
   large on every measured trial.

## What was verified

- Full git round-trips with the kit's own GitClient: clone, push,
  fast-forward refusal (exact `non-fast-forward` reason), tag create/delete,
  shallow depth 1, deepen 2 (shallow + unshallow lines), fetch-nothing-new
  (0 objects), incremental fetch (new tip only), malformed POST survival.
- Real git 2.43 clone + shallow clone + deepen against the entry (v2 fetch
  section order follows fetch-pack.c: no acknowledgments section when the
  request carries no haves; `ready` when a pack follows haves).
  Known limitation: real git's push reports success on the server but the
  git client reports "remote end hung up" after reading the report; the
  kit's own client parses the same report cleanly and every scored push
  check passes. Not scored, not pursued further.
- GraphQL: viewer, repository fields, introspection, issue/PR reads,
  mutations with REST cross-checks, node(id:) round-trip, batched
  operations, cursor pagination, invalid-field 200 + errors.
- MCP: server/discover (2026-07-28) + legacy initialize, tools/list
  byte-identical, all six tools, unknown-tool -32601, parse error 400 +
  -32700, missing-arguments isError, concurrent calls, REST parity, 401.
- REST: auth 401, request-id header on every reply, pagination via Link,
  contents CRUD with sha conflict 409, labels 422, PR squash merge with
  conflict 405.
