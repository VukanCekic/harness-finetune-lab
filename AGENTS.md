# harness-finetune-lab

## What
- Evals plus a QLoRA fine-tune of Qwen3-8B, for the coding agent in `D:\code\coding-harness`.
- Phases: the README phase table is the source of truth. Plan: `docs/plan.md`. Current status: `HANDOFF.md`.
- Stack: Node >=20.3, TypeScript, ESM, tsx, zod, yaml.

## Verify
- `npm run check` (typecheck + tests), `npm test` (tests only).
- `npm run eval:validate` after touching any task or check.
- `npm run eval:sync-tools` whenever the harness's tools or system prompt change; the baselines in `evals/results` are then stale.
- `npm run eval:compare` regenerates compare tables. Never hand-edit them.

## Needs
- Git for Windows (task checks are bash).
- LM Studio on `localhost:1234` for local rows.
- `OPENROUTER_API_KEY` in `D:\code\coding-harness\.env` for remote rows (only the keys are read).
- `harness.dir` in `evals/eval.config.yaml` is `D:/code/coding-harness`. `HARNESS_DIR` overrides it.

## Rules
- Remote eval runs cost money. Ask the user before running `npm run eval` on a remote model.
- Never train on eval tasks. Keep training tasks in a separate folder.
- Change only the model between runs.
- Always report the confidence interval. 11 tasks x 1 trial is not publishable.
- Changing runner code invalidates `--resume` on older runs.
- Hidden tests must be `.mjs`. Every task needs `solution/` (validate enforces it) and `fixtures/<name>/` known-wrong answers.
- Never commit `evals/results/*/trials/` (gitignored). Root-level `/*.pdf` is gitignored too.

## Where things live
- `evals/eval.config.yaml`: models and the pinned run settings.
- `evals/tasks/<id>/`: `task.yaml`, `workspace/`, `hidden/`, `solution/`, `fixtures/`.
- `evals/src/` runner, `evals/test/` tests, `evals/tool-schemas.json` harness tool snapshot.
- `evals/results/<run>/`: `summary.md` and `summary.json` committed, `trials/` ignored.
- `docs/plan.md`, `docs/reviews/`.

## Git
- Default branch `main`. Feature branch -> PR -> merge commit.
- Never squash: it orphans the commit hashes recorded in each run's `run.json`.
