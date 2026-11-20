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
