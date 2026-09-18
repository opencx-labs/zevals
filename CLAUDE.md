# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Zevals is a TypeScript library for testing AI agents as end-to-end scenarios: whole conversations checked with pass/fail assertions rather than metrics. It is a pnpm workspace under `packages/`. The adapter packages depend on `@zevals/core` via `workspace:^`.

- `core` (`@zevals/core`): the runtime (segments, criteria, runner). Its only runtime dependency is `zod`, and it should stay that way. Integrations are injected as interfaces (`Judge`, `SyntheticUser`, `Agent`, `JevClient`).
- `langchain`, `vercel`: adapters that turn LangChain runnables or Vercel AI SDK models into `Judge` / `SyntheticUser` / `Agent`.
- `autoevals`: wraps Braintrust autoevals scorers as a `Criterion`.
- `tau-bench`: a tau-bench retail environment (policy, a local tools server, DB fixtures) for benchmarking.
- `test` (private): all cross-package tests and the README examples.

## Commands

```sh
pnpm install
pnpm build                  # pnpm -r build (tsc per package)
pnpm test                   # build, then vitest run across all packages
npx vitest run packages/test/src/jev-judge.spec.ts            # one file
npx vitest run packages/test/src/new-features.spec.ts -t "repeat"   # one test by name
(cd packages/test && npx tsc -p . --noEmit)                   # typecheck tests
npx prettier --write <files>   # singleQuote, trailingComma all, printWidth 100
```

- **Tests import `@zevals/core` from `packages/core/dist`, not from source.** After changing core, rebuild it (`cd packages/core && npx tsc -p .`) before running tests, or they will run against the old build.
- **Builds are incremental (`composite` + `tsconfig.tsbuildinfo`).** If you delete a package's `dist`, delete its `tsconfig.tsbuildinfo` too. Otherwise `tsc` only re-emits changed files and leaves `dist` half-built.
- **`pnpm -r build` / `pnpm install` can stop with `ERR_PNPM_IGNORED_BUILDS` (esbuild).** It may write an `allowBuilds` placeholder into `pnpm-workspace.yaml`; revert that. Building a package directly with `npx tsc -p .` avoids it.
- **ESLint isn't runnable as configured:** the repo has a legacy `.eslintrc.js`, but ESLint 9 needs `eslint.config.*`. Prettier and `tsc` are the checks that actually run.
- **Some tests hit live LLMs.** The `eval-runner.spec.ts`, `autoevals.spec.ts`, `faithfulness.spec.ts` and `examples/` tests need `OPENAI_API_KEY`. Vitest loads `.env` from the root (`vite.config.mts`). `new-features.spec.ts` and `jev-judge.spec.ts` are fully mocked.

## Architecture

**Scenario model.** `evaluate({ agent, segments })` (`core/src/eval-runner.ts`) runs `Segment`s in order. Each segment gets the actual message history so far and returns messages and/or eval promises (`core/src/segment.ts`):

- `message`: adds a fixed message.
- `dynamicMessage`: computes the next message from the transcript.
- `agentResponse`: calls `agent.invoke`.
- `aiEval(criterion)`: schedules `criterion.evaluate` on the history so far.
- `userSimulation({ user, until, max })`: loops synthetic user → agent → `until` criterion. It flips user/assistant roles when talking to the synthetic user, and records an explicit failure when `max` is reached.

Eval promises from `aiEval` are awaited together at the end, so criteria run concurrently and don't block the conversation. Results are looked up by **criterion instance identity** (`getResult(criterion)`), so keep a reference to the exact object you passed in.

**Criteria** (`core/src/criteria/`) implement `Criterion<Output> { name, evaluate({ messages }) → CriterionResult }`. `CriterionResult` carries `output`, `status` (`success` / `failure`), `reason`, and `error`. `Criterion.scoped / negate / and / pipe` compose criteria. `scopeMessages` (`fullTranscript` | `lastAssistantTurn`) is the shared way to limit what a criterion sees.

**`aiAssertion` has two kinds of judge** (`criteria/assertion.ts`):

- **LLM `Judge`** (`Judge.invoke({ messages, schema })` returns a zod-typed `output`). This judge gets an XML-tagged prompt and returns `{ verdict, reason }`. Its errors throw.
- **`JevClient`** (`criteria/jev.ts`, marked with `kind: 'jev'`). This judge returns a calibrated probability, which is compared against `threshold`. Its errors come back as a failed result with `error` set.
  - Jev-only options (`threshold`, `criteria`, `explainFailures`) are a compile error with an LLM judge, because `AiAssertionOptions` is a union.
  - `openRouterJevClient` (`criteria/jev-openrouter.ts`) calls an **alpha** OpenRouter endpoint. The wire-format caveats are recorded, with the date they were verified, in that file's header comment. Check them there before changing the client.

**Transcript text.** `core/src/format.ts` (`formatMessage`, internal, not exported) renders messages as `[role] content` plus tool-call lines. `formatTranscript` uses it for display, and the Jev judge also uses it as model input, so changing the format changes what Jev scores. The LLM `aiAssertion` prompt uses its own `<role>…</role>` format. Keep that one byte-stable, because changing it changes existing users' verdicts.

**Public surface.** `core/src/index.ts` re-exports modules with `export *` and also builds a default `zevals` object from the same modules. Anything exported from `criteria/index.ts`, `eval-runner.ts` or `segment.ts` becomes public API.

## Conventions

- In `@zevals/core`: no `any`, no `as` casts and no non-null assertions in new code. Parse untrusted data (LLM/HTTP responses) with zod. (Some older code still uses `any`/`as`.)
- Tests live in `packages/test/src/*.spec.ts` and use vitest globals. Mock at the injected interface (`Judge`, `JevClient`, `fetch`) instead of calling live services.
- The root `README.md` is the real documentation, and each package's `npm.README.md` just links to it. Document new criteria and segments there.
- Releases: `pnpm publish-packages` syncs every package's version from the root `package.json` (`scripts/update-version.js`), then tests and publishes. Do not bump package versions by hand.
- The GitHub repo is `opencx-labs/zevals` (formerly `openchatai/zevals`). Greptile reviews PRs there.
