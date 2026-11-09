import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import workflowExtension, { createLaunchSnapshot, RunStore } from "../src/index.js";
import type { RunState } from "../src/types.js";
import { contextualWorkflowAction, testExtensionApi, waitForIssue105 } from "./support.js";

type ControlResult = { details: { runId: string; accepted?: boolean; stopped?: boolean } };

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "piewf-checkpoint-occurrence-"));
  const notices: string[] = [];
  const context = { cwd: home, hasUI: false, model: { provider: "offline-fixture", id: "unused" }, sessionManager: { getSessionId: () => "session" }, ui: { notify: (message: string) => notices.push(message) } };
  const attach = () => {
    const tools = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const events = new Map<string, (...args: unknown[]) => Promise<void>>();
    let command: ((args: string, context: unknown) => Promise<void>) | undefined;
    workflowExtension(testExtensionApi({
      registerTool(tool) { if (tool.execute) tools.set(tool.name, tool.execute.bind(tool)); },
      on(name, handler) { events.set(name, handler); },
      registerCommand(name, value) { if (name === "workflow") command = value.handler as typeof command; },
      getActiveTools: () => ["workflow", "workflow_respond", "workflow_stop", "workflow_resume", "workflow_retry"],
    }), home);
    return {
      execute: async (tool: string, params: object) => {
        const execute = tools.get(tool);
        assert.ok(execute, tool);
        return await execute(tool, params, undefined, undefined, context) as ControlResult;
      },
      resume: async (runId: string) => {
        assert.ok(command);
        await contextualWorkflowAction(command, context, runId, "Resume", "Background");
      },
      start: () => events.get("session_start")?.({}, context),
      shutdown: () => events.get("session_shutdown")?.(),
    };
  };
  let host = attach();
  t.after(async () => {
    try { await host.shutdown(); } finally { await rm(home, { recursive: true, force: true, maxRetries: 5 }); }
  });
  const store = (runId: string) => new RunStore(home, "session", runId, home);
  return {
    store,
    execute: (tool: string, params: object) => host.execute(tool, params),
    launch: async (script: string) => store((await host.execute("workflow", { name: "gate", script })).details.runId),
    start: () => host.start(),
    resume: (runId: string) => host.resume(runId),
    notices,
    restart: async () => { await host.shutdown(); host = attach(); await host.start(); },
  };
}

async function pending(store: RunStore, prompt: string) {
  await waitForIssue105(async () => (await store.awaitingCheckpoints()).some((checkpoint) => checkpoint.prompt === prompt)
    || (await store.load()).run.state === "completed");
  const checkpoint = (await store.awaitingCheckpoints()).find((item) => item.prompt === prompt);
  assert.ok(checkpoint?.occurrenceId, `Missing pending occurrence for "${prompt}"`);
  return { ...checkpoint, occurrenceId: checkpoint.occurrenceId };
}

async function waitForState(store: RunStore, state: RunState) {
  await waitForIssue105(async () => (await store.load()).run.state === state);
}

for (const literalFirst of [false, true]) {
  void test(`literal foo#2 and repeated foo receive independent decisions (literal first: ${String(literalFirst)})`, async (t) => {
    const host = await fixture(t);
    const literal = "const literal = await checkpoint({name:'foo#2',prompt:'literal',context:null});";
    const repeated = `const first = await checkpoint({name:'foo',prompt:'first',context:null});
      const second = await checkpoint({name:'foo',prompt:'second',context:null});`;
    const store = await host.launch(`${literalFirst ? literal + repeated : repeated + literal} return {first,second,literal};`);
    const respond = (selector: { name: string } | { occurrenceId: string }, approved: boolean) =>
      host.execute("workflow_respond", { runId: store.runId, ...selector, approved });
    const prompts = literalFirst ? ["literal", "first", "second"] : ["first", "second", "literal"];
    const occurrences = new Set<string>();
    for (const prompt of prompts) {
      const checkpoint = await pending(store, prompt);
      assert.equal(occurrences.has(checkpoint.path), false);
      occurrences.add(checkpoint.path);
      if (prompt === prompts[2]) assert.equal((await respond({ name: "foo#2" }, true)).details.accepted, false);
      assert.equal((await respond({ occurrenceId: checkpoint.occurrenceId }, prompt === "second")).details.accepted, true);
    }
    await waitForState(store, "completed");
    assert.deepEqual(JSON.parse(await readFile(join(store.directory, "result.json"), "utf8")), { first: "rejected", second: "approved", literal: "rejected" });
  });
}

void test("concurrent matching labels require distinct IDs and only one contradictory response commits", async (t) => {
  const host = await fixture(t);
  const store = await host.launch(`const gate = (name, prompt) => checkpoint({name:'fallback',prompt,context:null,...{name}});
    return parallel('outer/a', { one: () => parallel('inner#2', {
      first: () => gate('foo','first'), second: () => gate('foo','second')
    }), literal: () => gate('foo#2','literal') });`);
  const first = await pending(store, "first");
  const second = await pending(store, "second");
  const literal = await pending(store, "literal");
  const respond = (selector: { name: string } | { occurrenceId: string }, approved: boolean, runId = store.runId) =>
    host.execute("workflow_respond", { runId, ...selector, approved });
  assert.equal((await respond({ name: "foo#2" }, true)).details.accepted, false);
  const other = await host.launch("return checkpoint({name:'foo#2',prompt:'other run',context:null});");
  await pending(other, "other run");
  assert.equal((await respond({ occurrenceId: second.occurrenceId }, true, other.runId)).details.accepted, false);
  const results = await Promise.all([respond({ occurrenceId: second.occurrenceId }, true), respond({ occurrenceId: second.occurrenceId }, false)]);
  assert.deepEqual(results.map(({ details }) => details.accepted), [true, false]);
  assert.equal((await store.replay(second.path))?.checkpoint?.occurrenceId, second.occurrenceId);
  assert.equal((await store.replay(second.path))?.value, true);
  assert.equal((await respond({ name: "foo#2" }, true)).details.accepted, false);
  await respond({ occurrenceId: first.occurrenceId }, false);
  await respond({ occurrenceId: literal.occurrenceId }, false);
  await waitForState(store, "completed");
  assert.deepEqual(JSON.parse(await readFile(join(store.directory, "result.json"), "utf8")), {
    one: { first: "rejected", second: "approved" }, literal: "rejected",
  });
});

for (const stopFirst of [true, false]) {
  void test(`checkpoint response and stop serialize in arrival order (stop first: ${String(stopFirst)})`, async (t) => {
    const host = await fixture(t);
    const store = await host.launch("await checkpoint({name:'gate',prompt:'gate',context:null}); return checkpoint({name:'next',prompt:'next',context:null});");
    const { occurrenceId, path } = await pending(store, "gate");
    const stop = () => host.execute("workflow_stop", { runId: store.runId });
    const respond = () => host.execute("workflow_respond", { runId: store.runId, occurrenceId, approved: true });
    const attempts = stopFirst ? [stop(), respond()] : [respond(), stop()];
    const results = await Promise.all(attempts);
    assert.equal(results[stopFirst ? 0 : 1]?.details.stopped, true);
    assert.equal(results[stopFirst ? 1 : 0]?.details.accepted, !stopFirst);
    assert.equal((await store.replay(path))?.value, stopFirst ? undefined : true);
    assert.equal((await respond()).details.accepted, false);
    await waitForState(store, "stopped");
  });
}

void test("a reopened checkpoint rejects its previous response ID and legacy name", async (t) => {
  const host = await fixture(t);
  const store = await host.launch("return checkpoint({name:'gate',prompt:'gate',context:null});");
  const before = await pending(store, "gate");
  await host.restart();
  const respond = (selector: { name: string } | { occurrenceId: string }) =>
    host.execute("workflow_respond", { runId: store.runId, ...selector, approved: false });
  assert.equal((await respond({ occurrenceId: before.occurrenceId })).details.accepted, false);
  await host.resume(store.runId);
  const after = await pending(store, "gate");
  assert.equal(after.path, before.path);
  assert.notEqual(after.occurrenceId, before.occurrenceId);
  assert.equal((await respond({ occurrenceId: before.occurrenceId })).details.accepted, false);
  assert.equal((await respond({ name: "gate" })).details.accepted, false);
  assert.equal((await respond({ occurrenceId: after.occurrenceId })).details.accepted, true);
  await waitForState(store, "completed");
  assert.equal((await store.replay(after.path))?.value, false);
});

void test("explicit retry replays a completed scoped checkpoint and refuses the prior response ID", async (t) => {
  const host = await fixture(t);
  const source = await host.launch(`await parallel('outer', { nested: () => checkpoint({name:'gate',prompt:'gate',context:null}) });
    throw new Error('offline fixture failure');`);
  const occurrence = await pending(source, "gate");
  const answer = await host.execute("workflow_respond", { runId: source.runId, occurrenceId: occurrence.occurrenceId, approved: true });
  assert.equal(answer.details.accepted, true);
  await waitForState(source, "failed");
  const retried = await host.execute("workflow_retry", { runId: source.runId, foreground: false });
  const child = host.store(retried.details.runId);
  await waitForState(child, "failed");
  assert.deepEqual(await child.awaitingCheckpoints(), []);
  assert.deepEqual(await child.replay(occurrence.path), await source.replay(occurrence.path));
  assert.equal((await host.execute("workflow_respond", { runId: child.runId, occurrenceId: occurrence.occurrenceId, approved: false })).details.accepted, false);
});

void test("legacy unique answers replay and ambiguous suffixed history blocks recovery", async (t) => {
  const host = await fixture(t);
  const seed = async (runId: string, name: string) => {
    const store = host.store(runId);
    const metadata = { name: "legacy-gate", description: "legacy checkpoint" };
    const script = `return checkpoint({name:${JSON.stringify(name)},prompt:'legacy',context:null});`;
    await store.create({ id: runId, sessionId: "session", cwd: store.cwd, workflowName: metadata.name, state: "interrupted", agents: [], agentSessions: [] },
      createLaunchSnapshot({ identityVersion: 5, args: null, script, metadata, models: [], tools: [], agentTypes: [], roles: {}, schemas: [], settings: { concurrency: 1 } }));
    await store.awaitCheckpoint({ path: `checkpoint/${encodeURIComponent(name)}`, name, prompt: "legacy", context: null });
    await store.answerCheckpoint(name, false);
    return store;
  };
  const safe = await seed("safe-v5", "gate");
  const ambiguous = await seed("ambig-v5", "gate#2");
  await host.start();
  await host.resume(safe.runId);
  assert.ok(host.notices.some((notice) => /Resumed workflow legacy-gate/.test(notice)));
  await waitForState(safe, "completed");
  assert.equal(JSON.parse(await readFile(join(safe.directory, "result.json"), "utf8")), "rejected");
  await host.resume(ambiguous.runId);
  assert.ok(host.notices.some((notice) => /Historical checkpoint labels cannot be disambiguated/.test(notice)));
  await waitForState(ambiguous, "interrupted");
});

void test("cold resume supersedes a legacy wait before admitting a concurrent response", async (t) => {
  const host = await fixture(t);
  const store = host.store("legacy");
  const metadata = { name: "legacy-gate" };
  const script = "return checkpoint({name:'gate',prompt:'gate',context:null});";
  await store.create({ id: store.runId, sessionId: "session", cwd: store.cwd, workflowName: metadata.name, state: "interrupted", agents: [], agentSessions: [] },
    createLaunchSnapshot({ identityVersion: 5, args: null, script, metadata, models: [], tools: [], agentTypes: [], roles: {}, schemas: [], settings: { concurrency: 1 } }));
  await store.awaitCheckpoint({ path: "checkpoint/gate", name: "gate", prompt: "gate", context: null });
  await host.start();
  let concurrent: Promise<ControlResult> | undefined;
  const validate = Object.getOwnPropertyDescriptor(RunStore.prototype, "validateCheckpointHistory")?.value as RunStore["validateCheckpointHistory"];
  t.mock.method(RunStore.prototype, "validateCheckpointHistory", async function (this: RunStore) {
    await validate.call(this);
    concurrent ??= host.execute("workflow_respond", { runId: store.runId, name: "gate", approved: true });
  });
  await host.resume(store.runId);
  assert.ok(concurrent);
  assert.equal((await concurrent).details.accepted, false);
  const { occurrenceId } = await pending(store, "gate");
  assert.equal((await host.execute("workflow_respond", { runId: store.runId, occurrenceId, approved: false })).details.accepted, true);
  await waitForState(store, "completed");
  assert.equal(JSON.parse(await readFile(join(store.directory, "result.json"), "utf8")), "rejected");
});

void test("same-site concurrent occurrences get separate decisions and block ambiguous retry", async (t) => {
  const host = await fixture(t);
  const store = await host.launch(`await Promise.all([1, 2].map(() => checkpoint({name:'gate',prompt:'same',context:null})));
    throw new Error('offline fixture failure');`);
  await waitForIssue105(async () => (await store.awaitingCheckpoints()).length === 2);
  const waiting = await store.awaitingCheckpoints();
  assert.equal(new Set(waiting.map(({ path }) => path)).size, 2);
  assert.equal(new Set(waiting.map(({ occurrenceId }) => occurrenceId)).size, 2);
  for (const [index, checkpoint] of waiting.entries()) {
    const result = await host.execute("workflow_respond", { runId: store.runId, occurrenceId: checkpoint.occurrenceId, approved: index === 0 });
    assert.equal(result.details.accepted, true);
  }
  await waitForState(store, "failed");
  await assert.rejects(host.execute("workflow_retry", { runId: store.runId, foreground: false }), /Checkpoint order cannot be proven for recovery/);
});

for (const placement of ["shared helper", "repeated named scope"]) {
  void test(`a sequentially answered ${placement} cannot replay under a different caller`, async (t) => {
    const host = await fixture(t);
    const script = placement === "shared helper" ? `async function branch(which) {
      await checkpoint({name:'prep',prompt:which,context:null,...{name:which}});
      return checkpoint({name:'apply',prompt:'apply',context:null});
    }
    await Promise.all([branch('A'), branch('B')]);` : `const pending = [];
    for (const which of ['A','B']) pending.push(parallel('fan', { branch: async () => {
      await checkpoint({name:'prep',prompt:which,context:null,...{name:which}});
      return checkpoint({name:'apply',prompt:'apply',context:null});
    } }));
    await Promise.all(pending);`;
    const source = await host.launch(script + "throw new Error('offline fixture failure');");
    const a = await pending(source, "A");
    const b = await pending(source, "B");
    const respond = (occurrenceId: string, approved: boolean) => host.execute("workflow_respond", { runId: source.runId, occurrenceId, approved });
    await respond(b.occurrenceId, true);
    const applyB = await pending(source, "apply");
    await respond(applyB.occurrenceId, true);
    await respond(a.occurrenceId, true);
    const applyA = await pending(source, "apply");
    assert.notEqual(applyB.occurrenceId, applyA.occurrenceId);
    await respond(applyA.occurrenceId, false);
    await waitForState(source, "failed");
    await assert.rejects(host.execute("workflow_retry", { runId: source.runId, foreground: false }), /Checkpoint order cannot be proven for recovery/);
  });
}
