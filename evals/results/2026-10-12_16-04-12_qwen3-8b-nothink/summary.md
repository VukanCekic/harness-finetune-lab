# qwen3-8b-nothink

local `qwen3-8b` · harness `e694374` · lab `dcb761a` (dirty) · 11 tasks × 1 trial · context 32768 · 2026-10-12 16:04

sampling temp 0.7, top_p 0.8, top_k 20, seed 20261009+ · thinking off · budget 40 steps, 8192 tokens/request, 60000 tokens/trial, safety net 1800s

| pass@1 (95% CI over 11 tasks) | valid tool calls (all agents) | mean cost | p50 / p95 time | mean steps | thinking |
|---|---|---|---|---|---|
| 18.2% [0.0, 45.4] | 100.0% of 503, 4 errored | $0.0000 | 17.7s / 651.1s | 9.2 | 0.1% of tokens |

## Trial outcomes

| outcome | trials | counted in the pass rate |
|---|---|---|
| passed | 2 | yes |
| checks_failed | 8 | yes |
| max_steps | 1 | yes |

## Tasks

| task | difficulty | passed | invalid | valid tool calls | mean time | mean steps | mean cost |
|---|---|---|---|---|---|---|---|
| add-json-flag | medium | 0/1 |  | 100.0% | 28.7s | 4.0 | $0.0000 |
| callback-to-promise | medium | 0/1 |  | 100.0% | 651.1s | 40.0 | $0.0000 |
| checkout-bugs | hard | 0/1 |  | 100.0% | 50.3s | 12.0 | $0.0000 |
| csv-to-json | medium | 0/1 |  | 100.0% | 15.3s | 7.0 | $0.0000 |
| expr-eval | hard | 0/1 |  | 100.0% | 34.9s | 9.0 | $0.0000 |
| fix-off-by-one | easy | 1/1 |  | 100.0% | 17.7s | 8.0 | $0.0000 |
| hello-cli | easy | 0/1 |  | 100.0% | 6.3s | 2.0 | $0.0000 |
| lru-cache | hard | 0/1 |  | 100.0% | 14.2s | 4.0 | $0.0000 |
| rename-symbol | easy | 1/1 |  | 100.0% | 11.1s | 5.0 | $0.0000 |
| slugify | medium | 0/1 |  | 100.0% | 23.8s | 5.0 | $0.0000 |
| word-count-cli | medium | 0/1 |  | 100.0% | 11.9s | 5.0 | $0.0000 |

## Failures

- **add-json-flag** #1: `--json works and the text output is unchanged`
- **callback-to-promise** #1: max_steps: ran out of steps before the checks passed
- **checkout-bugs** #1: `visible and hidden tests pass`
- **csv-to-json** #1: `people.json was produced`, `converts this CSV and one it never saw`
- **expr-eval** #1: `evaluates and rejects correctly, with eval and Function disabled`
- **hello-cli** #1: `one name`, `no name`, `several words`, `another name`, `another set of words`
- **lru-cache** #1: `LRU behaviour`
- **slugify** #1: `slugify spec`
- **word-count-cli** #1: `counts and errors`
