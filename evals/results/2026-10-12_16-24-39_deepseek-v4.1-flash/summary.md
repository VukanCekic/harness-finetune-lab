# deepseek-v4.1-flash

remote `deepseek/deepseek-v4.1-flash` · harness `e694374` · lab `dcb761a` (dirty) · 11 tasks × 1 trial · context 32768 · 2026-10-12 16:24

sampling temp 0.6, seed 20261009+ · thinking default · provider gmicloud · budget 40 steps, 8192 tokens/request, 60000 tokens/trial, safety net 1800s

| pass@1 (95% CI over 11 tasks) | valid tool calls (all agents) | mean cost | p50 / p95 time | mean steps | thinking |
|---|---|---|---|---|---|
| 100.0% [71.5, 100.0] | 100.0% of 71 | $0.0032 | 25.5s / 39.7s | 6.2 | 28.7% of tokens |

## Trial outcomes

| outcome | trials | counted in the pass rate |
|---|---|---|
| passed | 11 | yes |

Global installs attempted: 0. Trials with a tool call outside the workspace: 2.

## Tasks

| task | difficulty | passed | invalid | valid tool calls | mean time | mean steps | mean cost |
|---|---|---|---|---|---|---|---|
| add-json-flag | medium | 1/1 |  | 100.0% | 19.5s | 5.0 | $0.0027 |
| callback-to-promise | medium | 1/1 |  | 100.0% | 35.1s | 9.0 | $0.0036 |
| checkout-bugs | hard | 1/1 |  | 100.0% | 37.2s | 9.0 | $0.0036 |
| csv-to-json | medium | 1/1 |  | 100.0% | 35.8s | 6.0 | $0.0030 |
| expr-eval | hard | 1/1 |  | 100.0% | 39.7s | 6.0 | $0.0071 |
| fix-off-by-one | easy | 1/1 |  | 100.0% | 19.4s | 6.0 | $0.0025 |
| hello-cli | easy | 1/1 |  | 100.0% | 15.8s | 5.0 | $0.0010 |
| lru-cache | hard | 1/1 |  | 100.0% | 22.5s | 4.0 | $0.0031 |
| rename-symbol | easy | 1/1 |  | 100.0% | 26.7s | 7.0 | $0.0026 |
| slugify | medium | 1/1 |  | 100.0% | 25.2s | 6.0 | $0.0034 |
| word-count-cli | medium | 1/1 |  | 100.0% | 25.5s | 5.0 | $0.0030 |

## Tool calls outside the workspace

- expr-eval #1: other - `bash` C:/Users/vukan/AppData/Local/Temp/t.mjs
- word-count-cli #1: other - `bash` C:/Users/vukan/AppData/Local/Temp/acc.txt
- word-count-cli #1: other - `bash` C:/Users/vukan/AppData/Local/Temp/empty.txt
- word-count-cli #1: other - `bash` C:/Users/vukan/AppData/Local/Temp
