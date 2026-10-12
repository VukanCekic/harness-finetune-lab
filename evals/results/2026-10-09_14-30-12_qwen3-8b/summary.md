# qwen3-8b

local `qwen3-8b` · harness `f552961` · 11 tasks × 1 trials · context 40000 · timeout 300s · max steps 40 · 2026-10-09 14:30

| pass@1 | pass@1 | pass^1 | flaky | valid tool calls | mean cost | p50 / p95 time | mean steps | timeouts | global installs |
|---|---|---|---|---|---|---|---|---|---|
| 36.4% | 36.4% | 36.4% | 0 | 100.0% of 34 | $0.0000 | 104.5s / 300.2s | 3.8 | 3 | 0 |

## Tasks

| task | difficulty | passed | valid tool calls | mean time | mean steps | mean cost |
|---|---|---|---|---|---|---|
| add-json-flag | medium | 0/1 | 100.0% | 57.1s | 3.0 | $0.0000 |
| callback-to-promise | medium | 0/1 | 100.0% | 300.2s | 10.0 | - |
| checkout-bugs | hard | 0/1 | 100.0% | 124.9s | 8.0 | $0.0000 |
| csv-to-json | medium | 0/1 | - | 300.2s | 0.0 | - |
| expr-eval | hard | 0/1 | 100.0% | 300.2s | 3.0 | - |
| fix-off-by-one | easy | 1/1 | 100.0% | 78.5s | 7.0 | $0.0000 |
| hello-cli | easy | 1/1 | 100.0% | 19.3s | 2.0 | $0.0000 |
| lru-cache | hard | 0/1 | 100.0% | 68.1s | 2.0 | $0.0000 |
| rename-symbol | easy | 1/1 | 100.0% | 104.5s | 3.0 | $0.0000 |
| slugify | medium | 1/1 | 100.0% | 115.2s | 2.0 | $0.0000 |
| word-count-cli | medium | 0/1 | 100.0% | 54.1s | 2.0 | $0.0000 |

## Failures

- **add-json-flag** #1: `--json works and the text output is unchanged`
- **callback-to-promise** #1: timed out after 300s
- **checkout-bugs** #1: `visible and hidden tests pass`
- **csv-to-json** #1: timed out after 300s
- **expr-eval** #1: timed out after 300s
- **lru-cache** #1: `LRU behaviour`
- **word-count-cli** #1: `counts and errors`
