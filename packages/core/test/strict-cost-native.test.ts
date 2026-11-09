import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension from "../src/host.js";
import { RunStore, listRunIds } from "../src/persistence.js";
import { STRICT_COST_MODEL } from "../src/strict-cost.js";
import type { StrictCostOpenAI } from "../src/strict-cost-openai.js";
import { testExtensionApi, testExtensionContextFor } from "./support.js";
type TestTool = Parameters<NonNullable<NonNullable<Parameters<typeof testExtensionApi>[0]>["registerTool"]>>[0];

function sse(turn: number, content: "text" | "result", complete: boolean): Response {
  const base = { id: `chatcmpl-fixture-${String(turn)}`, object: "chat.completion.chunk", created: 1, model: STRICT_COST_MODEL, service_tier: "default" };
  const delta = content === "text" ? { content: "intermediate prose" } :
    { tool_calls: [{ index: 0, id: "fixture-result", type: "function", function: { name: "workflow_result", arguments: '{"result":"fixture complete"}' } }] };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }], usage: null },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: content === "text" ? "stop" : "tool_calls" }], usage: null },
    ...(complete ? [{ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } } }] : []),
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

for (const scenario of ["admission", "repair", "missing_usage", "final_overrun", "provider_error", "cancelled", "parallel", "invalid_raw_open", "shell_refused", "stop", "shutdown"] as const) {
  void test(`offline native strict cost: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflow-native-strict-"));
    const agentDir = join(directory, "pi");
    await mkdir(agentDir);
    const tools = new Map<string, TestTool>();
    const context = testExtensionContextFor({ cwd: directory, headless: true, model: { provider: "openai", id: STRICT_COST_MODEL } });
    const sessionId = context.sessionManager.getSessionId();
    const controller = new AbortController();
    let calls = 0;
    let cancelledPeer = false;
    let abortedWhileRawStreamOpen = false;
    let shutdown: (() => Promise<void>) | undefined;
    let releaseFirst: () => void = () => undefined;
    const twoDispatched = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let dispatchReady: () => void = () => undefined;
    const dispatched = new Promise<void>((resolve) => { dispatchReady = resolve; });
    const fixtureErrors: unknown[] = [];
    const strict: StrictCostOpenAI = {
      apiKey: "fixture-key",
      approvedTariff: { source: "synthetic offline tariff v1", input: 1, cacheRead: 0.5, output: 2 },
      async fetch(url, init) {
        const turn = ++calls;
        try {
          assert.equal(url, "https://api.openai.com/v1/chat/completions");
          assert.equal(init?.redirect, "error");
          assert.ok(typeof init.body === "string");
          const [runId] = await listRunIds(directory, sessionId, directory);
          assert.ok(runId);
          const store = new RunStore(directory, sessionId, runId, directory);
          const entries = (await readFile(join(store.directory, "strict-cost.jsonl"), "utf8")).trim().split("\n");
          assert.match(entries.at(-1) ?? "", /"kind":"intent"/);
          if (scenario !== "parallel" && turn > 1) assert.match(entries.at(-2) ?? "", /"kind":"settlement"/);
          if (scenario !== "parallel" && turn === 2) assert.match(init.body, /Submit the final result/);
          if (scenario !== "parallel" && turn === 3) assert.match(init.body, /Repair it/);
        } catch (error) { fixtureErrors.push(error); throw error; }
        if (scenario === "parallel") {
          if (turn === 1) {
            await twoDispatched;
            return sse(turn, "result", false);
          }
          assert.equal(turn, 2, "the queued third agent must never dispatch");
          return new Promise<Response>((resolve) => {
            const abort = () => { cancelledPeer = true; resolve(sse(turn, "result", false)); };
            if (init.signal?.aborted) abort();
            else init.signal?.addEventListener("abort", abort, { once: true });
            releaseFirst();
          });
        }
        if (scenario === "invalid_raw_open") {
          const encoded = new TextEncoder().encode('data: {"object":"chat.completion.chunk","id":"bad","model":"unexpected","choices":[]}\n\n');
          let closed = false;
          return new Response(new ReadableStream<Uint8Array>({
            start(stream) {
              const close = () => { if (!closed) { closed = true; stream.close(); } };
              init.signal?.addEventListener("abort", () => {
                abortedWhileRawStreamOpen = !closed;
                close();
              }, { once: true });
              stream.enqueue(encoded);
              // A broken collector would wait for EOF before aborting the run.
              setTimeout(close, 500).unref();
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        if (scenario === "stop" || scenario === "shutdown") {
          const [runId] = await listRunIds(directory, sessionId, directory);
          assert.ok(runId);
          const store = new RunStore(directory, sessionId, runId, directory);
          return new Promise<Response>((resolve) => {
            init.signal?.addEventListener("abort", () => {
              void store.loadStatus().then(({ state }) => {
                assert.equal(state, "running", "terminal state was published before request settlement");
              }).catch((error: unknown) => { fixtureErrors.push(error); }).finally(() => { resolve(sse(turn, "result", false)); });
            }, { once: true });
            dispatchReady();
          });
        }
        if (scenario === "provider_error") return new Response(JSON.stringify({ error: { message: "synthetic rate limit" } }), { status: 429, headers: { "content-type": "application/json" } });
        if (scenario === "cancelled") {
          controller.abort();
          return sse(calls, "result", false);
        }
        if (scenario === "final_overrun") return sse(calls, "result", true);
        return sse(calls, calls < 3 ? "text" : "result", scenario !== "missing_usage" || calls !== 2);
      },
    };
    try {
      const attach = (capability?: StrictCostOpenAI) => { workflowExtension(testExtensionApi({
        on(event, handler) { if (event === "session_shutdown") shutdown = handler; },
        registerTool(tool) { tools.set(tool.name, tool); },
        getActiveTools: () => ["workflow"],
      }), directory, undefined, undefined, agentDir, [], capability); };
      attach(scenario === "admission" ? undefined : strict);
      const execute = tools.get("workflow")?.execute?.bind(tools.get("workflow"));
      assert.ok(execute);
      const params = {
        name: "strict-fixture", foreground: true,
        script: scenario === "shell_refused"
          ? 'return await shell("touch untracked-shell");'
          : scenario === "parallel"
          ? 'return await parallel("fan-out", { first: () => agent("first", { tools: [] }), second: () => agent("second", { tools: [] }), third: () => agent("third", { tools: [] }) });'
          : 'return await agent("synthesize the fixture", { label: "writer", tools: [] });',
        concurrency: 2,
        budget: { costUsd: { hard: scenario === "final_overrun" ? 0.00001 : 1, requireProvenance: true } },
      };
      if (scenario === "admission") {
        await assert.rejects(() => execute("strict", params, undefined, undefined, context), { code: "COST_PROVENANCE_UNAVAILABLE" });
        assert.deepEqual(await listRunIds(directory, sessionId, directory), []);
        assert.equal(calls, 0);
        return;
      }
      const operation = execute("strict", params, controller.signal, undefined, context);
      if (scenario === "repair") await operation;
      else {
        const rejected = assert.rejects(operation, { code: scenario === "shell_refused" ? "SHELL_FAILED" : "BUDGET_EXHAUSTED" });
        if (scenario === "stop" || scenario === "shutdown") {
          await dispatched;
          if (scenario === "stop") {
            const [runId] = await listRunIds(directory, sessionId, directory);
            const stop = tools.get("workflow_stop")?.execute?.bind(tools.get("workflow_stop"));
            assert.ok(stop);
            await stop("stop", { runId }, undefined, undefined, context);
          } else await shutdown?.();
        }
        await rejected;
      }
      if (scenario === "shell_refused") {
        assert.equal(calls, 0);
        await assert.rejects(() => readFile(join(directory, "untracked-shell")), { code: "ENOENT" });
        return;
      }
      if (scenario === "invalid_raw_open") assert.equal(abortedWhileRawStreamOpen, true);
      assert.deepEqual(fixtureErrors, []);
      assert.equal(calls, scenario === "repair" ? 3 : scenario === "missing_usage" || scenario === "parallel" ? 2 : 1);
      const [runId] = await listRunIds(directory, sessionId, directory);
      assert.ok(runId);
      const store = new RunStore(directory, sessionId, runId, directory);
      if (scenario === "parallel") assert.equal(cancelledPeer, true);
      const { run, snapshot } = await store.load();
      assert.equal(snapshot.budget?.costUsd?.requireProvenance, true);
      assert.equal(run.state, scenario === "repair" ? "completed" : scenario === "stop" ? "stopped" : scenario === "shutdown" ? "interrupted" : "budget_exhausted");
      if (scenario === "repair" || scenario === "final_overrun") {
        assert.equal(run.usage?.costProvenance?.status, "estimated");
        assert.ok(Math.abs(run.usage.costUsd - (scenario === "repair" ? 0.000051 : 0.000017)) < 1e-12);
      } else {
        assert.equal(run.usage?.costProvenance?.status, "unknown");
        await assert.rejects(() => readFile(join(store.directory, "result.json")), { code: "ENOENT" });
        const observed = run.agents.filter((agent) => agent.attemptDetails?.[0]?.session);
        assert.equal(observed.length, scenario === "parallel" ? 2 : 1);
        for (const agent of observed) {
          assert.equal(agent.attemptDetails?.[0]?.accounting.costProvenance?.status, "unknown");
          assert.equal(agent.accounting?.costProvenance?.status, "unknown");
        }
        assert.equal((await store.loadSummary()).usage.costProvenance?.status, "unknown");
      }
      const ledger = await readFile(join(store.directory, "strict-cost.jsonl"), "utf8");
      assert.doesNotMatch(ledger, /synthesize the fixture|fixture-key|chatcmpl-fixture/);
      if (scenario !== "repair") {
        await shutdown?.();
        attach(strict);
        const retry = tools.get("workflow_retry")?.execute?.bind(tools.get("workflow_retry"));
        const resume = tools.get("workflow_resume")?.execute?.bind(tools.get("workflow_resume"));
        assert.ok(retry && resume);
        await assert.rejects(() => retry("retry", { runId }, undefined, undefined, context), { code: "RESUME_INCOMPATIBLE" });
        await assert.rejects(() => resume("resume", { runId, budget: { costUsd: { hard: 10 } } }, undefined, undefined, context), { code: "RESUME_INCOMPATIBLE" });
      }
    } finally {
      await shutdown?.();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });
}
