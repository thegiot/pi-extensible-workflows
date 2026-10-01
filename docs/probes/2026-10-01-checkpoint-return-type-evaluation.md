# Checkpoint Return-Type Consistency Evaluation (Fork Issue #21)

**Issue:** [pi-extensible-workflows#21](https://github.com/thegiot/pi-extensible-workflows/issues/21) — parent epic [#15](https://github.com/thegiot/pi-extensible-workflows/issues/15). Evidence source: giot-workflows#24 / PR #30.
**Question:** should sandboxed `checkpoint()` (`"approved"`/`"rejected"`) and registered-function `WorkflowOrchestrationContext.checkpoint()` (boolean) expose the same decision type?
**Outcome (short): preserve both contracts; ship docs + a characterization regression only.** Unification is rejected on backward-compatibility grounds; the recorded failure was recipe-side misuse against a documented contract.

## 1. Exact adapter path producing the two return types

Both contracts are served by the **same host bridge** and diverge at exactly one site.

**Host bridge (single source of decisions):** `packages/core/src/host.ts:808` — `checkpointBridge(...)` returns `async (raw, signal): Promise<boolean>` (approved = `true`). It validates input, journals (`store.awaitCheckpoint` / `eventPublisher.checkpoint`), handles the headless policy path added by #19 (`--checkpoint-policy approve|reject`, plus `CheckpointPolicyHandler` decisions), interactive UI, and cancellation; every path returns a boolean.

**Registered functions (boolean, by reference):**
- Public type: `packages/core/src/types.ts:231` — `WorkflowOrchestrationContext.checkpoint: (input: CheckpointInput) => Promise<boolean>`.
- Wiring: `packages/core/src/host.ts:1323` (live launch) and `packages/core/src/host-recovery.ts:140` (cold resume) pass `checkpoint: checkpointBridge(...)` into `withWorkflowFunctions(...)`. Registered functions receive the bridge **itself** — no adapter, no mapping, `Promise<boolean>` end to end.

**Sandboxed scripts (string union, by value envelope):**
1. Sandbox client: `packages/core/src/execution.ts:259` — `const checkpoint = input => rpc("checkpoint", [input]).then(unwrap);`
2. Worker RPC handler: `packages/core/src/execution.ts:572-578` — calls `bridge.checkpoint(values[0], controller.signal)`, **enforces the boolean invariant** (`execution.ts:577`, `typeof result !== "boolean"` → `INTERNAL_ERROR "checkpoint must return a boolean"`), then maps it at **`execution.ts:578`**:
   `value = branded({ name, ok: true, value: result ? "approved" : "rejected" });` — this ternary is the **only** string-mapping site in the codebase.
3. Envelope unwrap: `packages/core/src/execution.ts:98-102` — `unwrap` returns `result.value` when `ok`, so the script observes the literal string.
4. Exposure: `packages/core/src/execution.ts:338` — the sandbox global table binds this `checkpoint`.

The mapping is a deliberate serialization choice inside the worker's JSON-RPC value envelope (branded `{name, ok, value}`), not an accident: the envelope predates the monorepo conversion (history truncated at `bc37e7f`), and the split is explicitly documented as a contract (below). Note the sandbox path is also the only place the boolean invariant is *enforced* (`:577`) — unification would delete that guard together with the mapping.

## 2. Existing reliance on each contract

**String contract (sandbox):**
- Documented: `docs/developers.html:246` — "Sandboxed workflow scripts receive `"approved"` or `"rejected"` from direct `checkpoint()`; registered functions receive a boolean from `WorkflowOrchestrationContext.checkpoint`."
- Tests: `packages/core/test/workflow-runtime.test.ts:146` (canonical — sandbox sample asserts `decision !== 'approved'`); `packages/core/test/lifecycle-controls.test.ts:77` (sandbox result compared as strings).
- Downstream: the lab's shipped recipes compare `decision === "approved"` (giot-workflows `recipes/plan-trip/recipe.js:580`, adopted in #24).

**Boolean contract (registered functions):**
- Public typed API `types.ts:231`; the checkpoint bridge type in `host-recovery.ts:36`; #19's headless policy plumbing (`host.ts:820-833` resolves policies to `approved: boolean` and calls `answerCheckpoint(runId, label, approved, ...)`).

**Adjacent vocabulary (not the return contract, but shares the words):** journal/state vocabulary uses `"approved"`/`"rejected"` independently — checkpoint state events (`lifecycle-controls.test.ts:89`), delivery messages (`runtime-acceptance.test.ts:1206`), provenance metadata (`decoders.ts:10-11`), and the `workflow_respond` tool's `approved: true` parameter (`host-navigator.ts:243`). A naive unification that touched state naming would ripple well beyond the return type.

**Tolerant-input precedent:** the policy layer already unions decisions — `CheckpointPolicyHandler` (`types.ts:357`) accepts `"approve" | "reject" | boolean`, and `host.ts:820-826` normalizes `decision === "approve" || decision === true`. Input tolerance exists where the host owns the boundary; the two *output* contracts are what #21 questions.

## 3. Compatibility assessment of unifying

| Option | Blast radius | Verdict |
| --- | --- | --- |
| 1. Sandbox → boolean | One line (`execution.ts:578` → `value: result`) — but **silently breaks** every documented, tested, and lab-adopted string comparison (`workflow-runtime.test.ts:146`, `lifecycle-controls.test.ts:77`, plan-trip `=== "approved"`). Also removes the `:577` boolean guard if done carelessly. | **Rejected** — breaking change against a documented contract for an ergonomics gain; exactly what the issue says to treat as first-class. |
| 2. Functions → string union | Breaks the public typed API (`types.ts:231`), downstream TS consumers, and forces boolean→string mapping into #19's headless policy plumbing. | **Rejected** — larger blast radius than option 1 and no ergonomics gain (strings are the hazard side). |
| 3. Preserve behavior; improve docs/diagnostics | Docs + tests only. | **Adopted** (with 4). |
| 4. Preserve unchanged | None. | **Adopted** as the runtime baseline. |

Key judgment: the #24 misrun was **recipe-side misuse against a documented contract** — the lab record itself files it as "Contract lesson (recipe-side, not an engine defect)", the journal recorded the rejection correctly (`value: false`, `provenance: "headless_policy"`), and both strings are truthy only because of the documented serialization. A silent return-type change would fix one idiom hazard by introducing a correctness hazard for every existing workflow. Meanwhile deferral is cheap: the mapping is a single guarded ternary, so a future major version can unify deliberately with a one-line change plus the regression below flips.

## 4. Regression added (characterization)

`packages/core/test/workflow-runtime.test.ts` gains "sandbox checkpoint resolves the documented truthy strings (rejection hazard characterization)": a sandbox script takes a checkpoint whose bridge returns `false`, performs the exact hazardous `if (!decision)` check, and asserts `decision === "rejected"` while `!!decision === true`. It pins the adapter path (`execution.ts:577-578` → `unwrap`) end to end: any future change to the mapping must consciously update this test and the documented contract, and until then it documents — in executable form — why `!decision` is wrong.

## 5. Documentation change

`docs/developers.html:246` extends the contract sentence with an explicit warning: both strings are truthy, compare against `"approved"` explicitly (never truthiness), referencing the #24 failure mode. Registered-function wording unchanged.

## 6. Recommendation

**Smallest upstream-compatible outcome = options 3 + 4:** preserve `"approved" | "rejected"` (sandbox) and `boolean` (registered functions) exactly as documented; add the characterization regression; add the truthiness warning to the developer guide. No behavior, authority, persistence, provenance, or headless-CLI semantics change (scope boundary respected; #19 semantics untouched). Revisit unification only in a deliberate major-version change that migrates `execution.ts:578`, the two string-contract tests, the developer guide, and downstream workflows together.
