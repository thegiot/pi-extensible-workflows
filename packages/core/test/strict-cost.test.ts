import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateBudget, validateBudgetPatch, WorkflowBudgetRuntime } from "../src/budget.js";
import { formatBudgetStatus } from "../src/host-view.js";
import { readStrictCost, StrictCostLedger } from "../src/strict-cost.js";
import { zeroAccounting } from "../src/types.js";

const tariff = { source: "fixture tariff v1", input: 1, cacheRead: 0.5, output: 2 };
const counters = { input: 10, cacheRead: 2, output: 3 };

void test("strict budget is explicit and cannot be added by a budget patch", () => {
  const strict = { costUsd: { requireProvenance: true, hard: 1 } };
  assert.deepEqual(validateBudget(strict), strict);
  assert.throws(() => validateBudgetPatch(strict), { code: "INVALID_METADATA" });
  assert.throws(() => validateBudget({ costUsd: { requireProvenance: true } }), { code: "INVALID_METADATA" });
  assert.deepEqual(validateBudget({ costUsd: { hard: 1 } }), { costUsd: { hard: 1 } });
});

void test("strict budgets ignore SDK costs and block at final estimated exhaustion", () => {
  const budget = validateBudget({ costUsd: { requireProvenance: true, hard: 1 } });
  const runtime = new WorkflowBudgetRuntime(budget);
  runtime.afterTurn({ ...zeroAccounting(), cost: 100 }, true);
  assert.equal(runtime.usage.costUsd, 0);
  runtime.observeCost({ status: "estimated", usd: 1 });
  assert.equal(runtime.hardExhausted, true);
  assert.throws(() => { runtime.checkAgentLaunch(); }, { code: "BUDGET_EXHAUSTED" });
});

void test("an unsettled request survives restart as unknown and a gap remains sticky across parallel settlements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-strict-cost-"));
  try {
    const seen: unknown[] = [];
    const ledger = await StrictCostLedger.create(dir, tariff, (value) => seen.push(value));
    const [first, second] = await Promise.all([ledger.begin("one"), ledger.begin("two")]);
    assert.deepEqual(await readStrictCost(dir), { status: "unknown", reason: "unsettled_request" });
    await ledger.settle(first, { status: "unknown", reason: "missing_usage" });
    await ledger.settle(second, { status: "estimated", counters });
    assert.deepEqual(await readStrictCost(dir), { status: "unknown", reason: "missing_usage" });
    assert.deepEqual(seen.at(-1), { status: "unknown", reason: "missing_usage" });
    await assert.rejects(() => ledger.begin("three"), { code: "BUDGET_EXHAUSTED" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

void test("explicit zero rates and complete raw counters give a known zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-strict-cost-"));
  try {
    const ledger = await StrictCostLedger.create(dir, { ...tariff, input: 0, cacheRead: 0, output: 0 }, () => undefined);
    const request = await ledger.begin("one");
    await ledger.settle(request, { status: "estimated", counters });
    await ledger.close();
    assert.deepEqual(await readStrictCost(dir), { status: "estimated", usd: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

void test("retained numeric SDK cost and unfinished provenance are unknown on strict recovery", () => {
  const budget = validateBudget({ costUsd: { requireProvenance: true, hard: 1 } });
  const legacy = new WorkflowBudgetRuntime(budget, 1, { costUsd: 0 });
  assert.deepEqual(legacy.usage.costProvenance, { status: "unknown", reason: "missing_provenance" });
  assert.throws(() => { legacy.checkAgentLaunch(); }, { code: "BUDGET_EXHAUSTED" });
  const pending = new WorkflowBudgetRuntime(budget, 1, { costUsd: 0, costProvenance: { status: "pending", usd: 0 } });
  assert.deepEqual(pending.usage.costProvenance, { status: "unknown", reason: "unsettled_request" });
  assert.throws(() => { pending.checkAgentLaunch(); }, { code: "BUDGET_EXHAUSTED" });
});

void test("native budget display distinguishes missing coverage from free and pending", () => {
  const budget = validateBudget({ costUsd: { requireProvenance: true, hard: 1 } });
  assert.ok(budget);
  const usage = { costUsd: 0, tokens: 0, agentLaunches: 1, durationMs: 0 };
  const unknown = formatBudgetStatus({ budget, usage: { ...usage, costProvenance: { status: "unknown", reason: "missing_usage" } } });
  assert.deepEqual(unknown, ["Budget version 1", "  costUsd: unknown (missing_usage) hard=1"]);
  const pending = formatBudgetStatus({ budget, usage: { ...usage, costProvenance: { status: "pending", usd: 0.1 } } });
  assert.deepEqual(pending, ["Budget version 1", "  costUsd: pending (0.1 settled) hard=1"]);
  assert.deepEqual(formatBudgetStatus({ budget: { costUsd: { hard: 1 } }, usage }), ["Budget version 1", "  costUsd: 0 hard=1 0.0%"]);
});
