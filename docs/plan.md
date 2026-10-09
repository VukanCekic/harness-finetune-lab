# Harness → Evals → Fine-tuned local model: your plan

**Story:** build agents → measure them → improve a small model with data → prove it with evals.
**This file:** how to do **Phase 1** (OpenAI-compatible provider) yourself, then how to start **Phase 2** (evals).
Nothing here is implemented yet. Everything below is a checklist for you.

Repo: `D:\code\coding-harness`, branch `feat/openai-compatible-provider` (renamed from `audit-v2-fixes`, base `26752c8`).

> **Status (2026-10-09): Phase 1 is done** - harness commit `f552961` on `feat/openai-compatible-provider` (not pushed).
> The design changed from this plan in one way: instead of `BASE_URL`, there is an explicit switch,
> `LLM_BACKEND=remote|local` or `--local` / `--remote`, with separate `LOCAL_MODEL`, `LOCAL_BASE_URL`,
> `LOCAL_API_KEY`. Wire-format findings: `coding-harness/docs/local-backend-wire-format.md`.
> Sections 2-4 below are kept as the original reasoning; the README in the harness repo is the source of truth now.
> **2026-10-09:** Phase 2 is underway in this repo (`evals/`), which was renamed from `finetune-plan` to `harness-finetune-lab`. Decision: own runner instead of forking InkByteStudio/agent-eval-harness - that harness never executes real tools, and has no LICENSE file.

---

## 0. What I found in the code (so you don't have to re-read it)

| Fact | Where | Why it matters |
|---|---|---|
| The only wire call is `openrouter.chat.send(...)` | `src/llm.ts:302` | One place to change. Everything else in the loop consumes *chunks*. |
| The transcript uses OpenRouter-SDK **camelCase** types (`toolCalls`, `toolCallId`, `reasoningDetails`) | `agent.ts`, `subagent.ts`, `history.ts`, `session.ts` | Session logs and `--resume` depend on it. **Keep this internal format.** Translate only at the wire. |
| Request carries OpenRouter-only fields: `provider`, `cacheControl` blocks | `llm.ts:309`, `withBreakpoints()` | A local server must never receive these. `cacheControl` is already gated on `anthropic/*` models. `provider` is only set if `PROVIDER_ONLY` is. |
| Cost comes from `usage.cost` (OpenRouter returns it) | `llm.ts:126`, `record()` | Local servers don't send it. It becomes `null` → ledger records `0`. That is correct for local, but say so in your results table. |
| Startup hard-fails if `OPENROUTER_API_KEY` is empty | `src/index.ts:415` | Local servers need no key. Must relax this. |
| Tests replace `globalThis.fetch` and script SSE chunks | `tests/helpers/mock.ts` | A fetch-based client slots into your existing test setup. |
| `config.contextWindow` defaults to 64k | `src/config.ts:100` | A local 7B with a smaller context will overflow before compaction kicks in. Set `CONTEXT_WINDOW` to match the server's `-c`. |
| `reasoningRoundTrip` defaults on | `src/config.ts:115` | Local servers don't understand `reasoning_details`. Drop it at the wire. |

## 1. Decision to make first: hand-rolled `fetch` vs the `openai` npm package

| | Hand-rolled `fetch` + SSE parser | `openai` npm package |
|---|---|---|
| Size | ~120 lines in one new file | New dependency |
| Camel↔snake conversion | You write it | **You still write it**, the package doesn't know your internal types |
| Retries / Retry-After | You write a small bounded loop | Built in |
| Tests | Works with your existing fetch mock | Also uses fetch, so mockable, but SSE shapes differ |
| Learning value | High: you see exactly what function calling looks like on the wire | Low |

**My recommendation: hand-rolled.** The conversion layer is the real work either way, and you want to *see* the tool-call deltas for the function-calling videos in your learning list. Switch to the package later only if the retry code becomes annoying.

---

## 2. Phase 1 checklist

### Step 1 — Branch and baseline (5 min)
```bash
cd /d/code/coding-harness
git checkout -b feat/openai-compatible-provider
npm run check          # typecheck + lint + tests must be green BEFORE you touch anything
```

### Step 2 — Look at the wire before writing code (30–45 min)
Start a local server with any tool-capable model (Qwen2.5/Qwen3 instruct GGUF). Pick **one**:

- **LM Studio:** Developer tab → start server. Base URL `http://localhost:1234/v1`. Models with the hammer badge have native tool support.
- **Ollama:** `http://localhost:11434/v1`. Needs a placeholder API key (any string). `tool_choice` is **not supported** (see below).
- **llama-server:** `llama-server -m <file.gguf> --jinja -c 16384 --port 8080` (add `--api-key <key>` if you want auth). `--jinja` is required for tool calling.

Then hit it by hand. Three requests, in this order, and **read every line of output**:

```bash
BASE=http://localhost:1234/v1    # change per server
MODEL=<id from: curl $BASE/models>

# a) plain, non-streaming
curl -s $BASE/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"'$MODEL'","messages":[{"role":"user","content":"Say hi"}]}'

# b) streaming + usage. Look for: where does usage arrive? Does the last chunk have "choices": []?
curl -sN $BASE/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"'$MODEL'","stream":true,"stream_options":{"include_usage":true},
  "messages":[{"role":"user","content":"Say hi"}]}'

# c) streaming + a tool. Look for: delta.tool_calls[].index / id / function.name / function.arguments,
#    whether the name arrives once or repeated, whether arguments are fragmented, finish_reason.
curl -sN $BASE/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"'$MODEL'","stream":true,"stream_options":{"include_usage":true},
  "messages":[{"role":"user","content":"What is in the file a.txt? Use the tool."}],
  "tools":[{"type":"function","function":{"name":"read_file","description":"Read a file",
    "parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]}'
```

Write down what you saw for each server you try (a short table in `docs/`). This is your "tool-call wire format" notes and it doubles as content for the post.

### Step 3 — Config (`src/config.ts`)
Add, alongside the existing keys:

- `baseUrl: process.env.BASE_URL || ""` — when empty, behave exactly as today (OpenRouter SDK).
- `apiKey`: keep `OPENROUTER_API_KEY` as the default, but allow `API_KEY` to override when `BASE_URL` is set.
- `MODEL` already exists and is passed through verbatim.

### Step 4 — New file `src/openaiCompat.ts`
Three small functions. Keep them pure so they can be unit-tested.

1. **`toWireMessages(messages)`**: internal → OpenAI:
   - `toolCalls` → `tool_calls`; `toolCallId` → `tool_call_id`.
   - Drop `reasoningDetails`.
   - If content is an array of blocks (cacheControl), flatten to a string.
   - Assistant message with tool calls and no text: send `content: null` (or `""`; if a server rejects one, try the other).
2. **`parseSSE(stream)`**: async generator over a `ReadableStream`:
   - Buffer bytes, split on blank lines, handle events split mid-line across network chunks.
   - Ignore lines starting with `:` (comments / keep-alives).
   - Stop on `data: [DONE]`.
3. **`normaliseChunk(raw)`**: snake_case chunk → the camelCase shape `callLLM` already reads (`choices[0].delta.content`, `.toolCalls[]`, `.reasoning`, `choices[0].finishReason`, `usage.promptTokens`, `usage.promptTokensDetails.cachedTokens`, ...).
   - Reasoning: llama-server puts thinking in `delta.reasoning_content`; map it to `reasoning` so TTFT metrics still count it.
   - Usage chunks may have `choices: []`. Don't crash on `choices[0]` being undefined.
   - `tool_calls[].index` may be missing on some servers: default to 0 (the loop already does this).

The request function: `POST {baseUrl}/chat/completions`, `Authorization: Bearer <key>` (only if a key is set), body = `model, messages, tools, stream: true, stream_options: { include_usage: true }`, plus `tool_choice` if requested and `max_tokens` if set. **Do not send `provider`.**

Pass the abort signal to `fetch`. Non-2xx: read the body and throw an error that includes the status. Retry only 429/5xx/connection errors, and only before the first byte arrives, with a bounded budget like the one at `llm.ts:19`.

### Step 5 — Wire it into `callLLM` (`src/llm.ts`)
- Replace the single `await openrouter.chat.send(...)` with: `const stream = config.baseUrl ? openaiCompatStream(...) : await openrouter.chat.send(...)`.
- Everything below it (the `for await`, tool-call accumulation, usage, metrics) should stay untouched. If you find yourself editing it, the normaliser is wrong.
- Construct the OpenRouter client lazily, or at least don't let it throw when no OpenRouter key exists.
- `usesBreakpoints()` returns false for non-`anthropic/` models, so no change needed. If you route an `anthropic/...` id through a custom base URL by accident, you'd send `cacheControl`: guard on `!config.baseUrl`.

### Step 6 — Startup and housekeeping
- `src/index.ts:415`: require a key only when `BASE_URL` is unset.
- Banner: show the base URL so it's obvious which backend a run used (`ui.banner(...)`).
- `src/sandbox.ts:150`: add `API_KEY` to the scrubbed env vars.
- `.env.example` and the env table in `README.md`: document `BASE_URL`, `API_KEY`, `CONTEXT_WINDOW`.
- Set `REASONING_ROUNDTRIP=0` in your local `.env` for local models.

### Step 7 — Tests (extend, don't replace)
Unit tests for the three functions, then one loop test:
- `parseSSE`: event split across two byte chunks; `: keepalive` line; `[DONE]`; CRLF line endings.
- `normaliseChunk`: usage chunk with empty `choices`; missing `index`; name resent in every delta; `reasoning_content`.
- `toWireMessages`: tool-call round trip produces `tool_calls` / `tool_call_id` and no camelCase keys.
- One loop test: mock fetch returns OpenAI-shaped SSE, assert the agent completes a tool call and the ledger records tokens with `cost 0`.
- Make sure the existing OpenRouter-path tests still pass untouched.

### Step 8 — Smoke test against the real thing
Start small: **not** boids. Use a task a 7B can do:
```bash
BASE_URL=http://localhost:1234/v1 MODEL=<id> CONTEXT_WINDOW=16000 REASONING_ROUNDTRIP=0 BYPASS_PERMISSIONS=1 \
  npm run dev -- "Create hello.ts that prints 'hi' and run it with tsx"
```
Then run the **same** command with no `BASE_URL` (OpenRouter/DeepSeek) to prove nothing regressed.

### Done when
- [ ] `npm run check` green
- [ ] DeepSeek via OpenRouter works exactly as before
- [ ] At least one local server completes the hello-world task with a real tool call
- [ ] Tokens are recorded in the ledger, with cost showing as 0
- [ ] Notes on wire formats committed under `docs/`
- [ ] One commit: `feat: OpenAI-compatible provider via BASE_URL`

---

## 3. Known unknowns (I could not confirm these. Check them in Step 2, don't assume)

- **Where `usage` arrives in streams** for each local server. The OpenAI docs page returned 403 to my fetch, and the llama-server README doesn't mention `stream_options`. Ollama lists `include_usage` as supported. Step 2b tells you.
- **llama-server's default port.** The README text I got said `9931`, which I don't trust. Pass `--port` explicitly.
- **Whether tool-call deltas are fragmented or arrive whole** on each server. LM Studio's docs say fragmented (name first, then arguments). Not confirmed for the other two.
- **Ollama has no `tool_choice`.** Your reviewer's "required" last turn (`toolChoice: "required"`) won't be enforced there. Fine for a baseline, but note it if a local reviewer run misbehaves.
- **Malformed tool calls from small models:** LM Studio says it falls back to putting the text in `content` instead of `tool_calls`. That is precisely the failure the Phase 2 *tool-call validity* scorer should count, so don't "fix" it in the provider.

## 4. Gotchas to expect

- A 7B model will be much worse than DeepSeek at your full system prompt + 15 tools. That's the point of the project, but don't conclude Phase 1 is broken because the model flounders. Check the **wire** (raw chunks) first, then blame the model.
- `CONTEXT_WINDOW` must be ≤ the server's context (`-c` in llama-server, the load setting in LM Studio), otherwise the server silently truncates.
- Windows: use `127.0.0.1` rather than `localhost` if you see IPv6 connection refusals.
- Qwen3 "thinking" output may land in `content` as `<think>…</think>` (LM Studio) or in `reasoning_content` (llama-server with `--reasoning-format deepseek`). Decide how you want it handled, and keep it consistent between baseline and fine-tuned runs.

---

## 5. Phase 2 kickoff (after Phase 1 is committed)

1. **License first.** Open `github.com/InkByteStudio/agent-eval-harness`, find the LICENSE. If there isn't one, you can't legally fork and redistribute. Ask the author or write your own small runner. Don't skip this.
2. Read its runner, task format and scorers before changing anything. Write one paragraph on how a task becomes a pass/fail.
3. The three additions:
   - **Adapter:** run the harness in a fresh temp dir with a task prompt and fixed env (`BASE_URL`, `MODEL`, `BYPASS_PERMISSIONS=1`, `SESSION_DIR=<run dir>`), then read the session log. *Idea:* the log you already write is your source of truth for tool calls, tokens, cost and latency.
   - **`command` check:** run a shell command in the temp dir, exit 0 = pass (`npm test`, `node out.js | grep ...`).
   - **Tool-call validity scorer:** for each assistant tool call in the log, `JSON.parse(arguments)` succeeds and matches the tool's schema. Report `valid / total`.
4. Write **10–15 tasks** now, and write the **training-task list separately** (Phase 4). Keep the two lists in different folders so you can't mix them up: *never train on eval tasks*.
5. Fix the 4 known harness issues **before** baselines if they affect scoring. #1 (Git Bash `nul` / `cd /d`) and #3 (`/tmp` can't see `node_modules`) will cause false failures in any task that runs scripts. #2 and #4 only matter for UI tasks and prompt display.
6. Metrics per (model × task × trial): pass, valid-tool-call %, cost, latency, steps. At least 3 trials. Change **only** the model between runs.

## 6. Why Phase 1's design pays off later

`toWireMessages()` is the same translation you'll need in **Phase 4**: exporting successful DeepSeek runs as training JSONL. Your logs are camelCase internally; training data needs the OpenAI/Qwen `tool_calls` shape. Write it once, test it well, reuse it.
