# Live score tracker — github-core-clone-01

House reference (calibration.json): 120/120 checks, perf 100 (25 x 4) -> ~900/1000.
T_ref medians: push 1640.82 ms, clone 266.941 ms, read 2759.715 ms, write 348.965 ms.
Perf formula per workload: round(clamp(25 - 12.5*log2(t / T_ref), 0, 50)).

## v0.1 — commit 4752835 (2026-11-20, grade-local trial-0, --driver process)

| column | result |
|---|---|
| feature | 600/600 (120/120 checks) |
| agent (MCP) | 200/200 (15/15 checks) |
| perf push | 38 (p50 810.628 ms) |
| perf clone | 31 (p50 195.780 ms) |
| perf read | 48 (p50 787.859 ms) |
| perf write | 41 (p50 140.316 ms) |
| perf total | 158/200 |
| perf_p50_us | 363946 |
| TOTAL | 958/1000 |

Weakest component: clone (31) — 50 concurrent shallow clones of a 200-commit repo;
then push (38), write (41), read (48, closest to 50).
Next optimization: cache identical shallow-clone pack bytes + issue-read JSON;
profile push handler (4 ms/push) for hot spots.

## v0.2 — commit 5333a8e (2026-11-20, grade-local trial-0, --driver process)

| column | result |
|---|---|
| feature | 600/600 (120/120 checks) |
| agent (MCP) | 200/200 (15/15 checks) |
| perf push | 37 (p50 835.760 ms) |
| perf clone | 37 (p50 138.658 ms) |
| perf read | 50 (p50 699.613 ms) |
| perf write | 40 (p50 155.744 ms) |
| perf total | 164/200 |
| perf_p50_us | 335215 |
| TOTAL | 964/1000 |

Changes vs v0.1: readPack re-deflate fast path (211.6 -> 131.2 ms per 200 parses),
fetch pack cache (clone 195.8 -> 138.7 ms), issue GET JSON cache (read 787.9 -> 699.6 ms).
Push/write moved -1 each: run-to-run noise (push rounds within one run span 734-890 ms).

## v0.2 — 3-trial run (2026-11-20, --instances 3, --driver process)

| trial | feature | agent | perf | total | perf_p50_us |
|---|---|---|---|---|---|
| 0 | 600 | 200 | 172 | 972 | 296349 |
| 1 | 600 | 200 | 164 | 964 | 330934 |
| 2 | 600 | 200 | 164 | 964 | 330929 |
| mean | 600 | 200 | 166.7 | 966.7 | — |

Nondeterministic trials: 0. All 120 checks pass on every trial; only perf varies.
Weakest component: push + write (perf noise dominates; server-side latency is at the
HTTP floor ~0.35-0.53 ms/req raw, the rest is client + contention).
