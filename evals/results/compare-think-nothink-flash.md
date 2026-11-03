| model | backend | harness | k | pass@1 (95% CI over tasks) | vs qwen3-8b (paired, 95% CI) | pass^k | valid tool calls | mean cost | p50 / p95 time | mean steps | invalid trials |
|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen3-8b | local | `f552961` | 1 | 36.4% [2.5, 70.3] | baseline | 36.4% | 100.0% | $0.0000 | 104.5s / 300.2s | 3.8 | - |
| qwen3-8b-nothink | local | `e694374` | 1 | 18.2% [0.0, 45.4] | -18.2% [-45.4, +9.0] on 11 tasks | 18.2% | 100.0% | $0.0000 | 17.7s / 651.1s | 9.2 | 0 |
| deepseek-v4.1-flash | remote | `e694374` | 1 | 100.0% [100.0, 100.0] | +63.6% [+29.7, +97.5] on 11 tasks | 100.0% | 100.0% | $0.0032 | 25.5s / 39.7s | 6.2 | 0 |

| task | qwen3-8b | qwen3-8b-nothink | deepseek-v4.1-flash |
|---|---|---|---|
| add-json-flag | 0/1 | 0/1 | 1/1 |
| callback-to-promise | 0/1 | 0/1 | 1/1 |
| checkout-bugs | 0/1 | 0/1 | 1/1 |
| csv-to-json | 0/1 | 0/1 | 1/1 |
| expr-eval | 0/1 | 0/1 | 1/1 |
| fix-off-by-one | 1/1 | 1/1 | 1/1 |
| hello-cli | 1/1 | 0/1 | 1/1 |
| lru-cache | 0/1 | 0/1 | 1/1 |
| rename-symbol | 1/1 | 1/1 | 1/1 |
| slugify | 1/1 | 0/1 | 1/1 |
| word-count-cli | 0/1 | 0/1 | 1/1 |
