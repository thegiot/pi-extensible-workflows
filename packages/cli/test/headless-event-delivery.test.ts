import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * [#22] regression: terminal workflow run events must reach extensions in
 * headless CLI runs so `registerWorkspaceLifecycle` can close Herdr workspace
 * containers (the repeat probe's workspace-container leak).
 *
 * Two delivery channels exist:
 * - the event bus (`pi.events.on`), which the headless runtime now shares with
 *   the workflow event publisher (previously the publisher emitted into a
 *   `{ emit() {} }` black hole);
 * - the hook channel (`pi.on(name, handler)`), which survives headless session
 *   churn — every AgentSession disposal invalidates the shared extension
 *   runtime and unsubscribes ALL load-time event-bus listeners, so the CLI
 *   re-emits terminal run events as hooks to extensions that registered for
 *   them.
 *
 * The fixture extension records deliveries on BOTH channels; the test asserts
 * the terminal chain (run-state-changed:completed + run-completed) arrives on
 * the hook channel with one shared runId. Before the fix neither channel
 * delivered headlessly (red), after the fix the hook channel always delivers
 * (green).
 */

function fixture(): { root: string; cwd: string; agentDir: string; deliveryLog: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-extensible-workflows-headless-events-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  return { root, cwd, agentDir, deliveryLog: join(root, "delivery.log") };
}

const FIXTURE_EXTENSION_SOURCE = [
  `import { appendFileSync } from "node:fs";`,
  `export default function extension(pi) {`,
  `  const log = process.env.HEADLESS_DELIVERY_LOG;`,
  `  if (!log) throw new Error("HEADLESS_DELIVERY_LOG is not set");`,
  `  const record = (channel) => (name) => (event) => {`,
  `    appendFileSync(log, JSON.stringify({ channel, name, runId: event?.runId, state: event?.state ?? null }) + "\\n");`,
  `  };`,
  `  pi.events.on("workflow:run-started", record("bus")("workflow:run-started"));`,
  `  pi.events.on("workflow:run-state-changed", record("bus")("workflow:run-state-changed"));`,
  `  pi.events.on("workflow:run-completed", record("bus")("workflow:run-completed"));`,
  `  const on = pi.on;`,
  `  on("workflow:run-state-changed", record("hook")("workflow:run-state-changed"));`,
  `  on("workflow:run-completed", record("hook")("workflow:run-completed"));`,
  `}`,
  "",
].join("\n");

void test("headless run delivers terminal run events to extensions on the hook channel", () => {
  const paths = fixture();
  // Declared via the agent-dir settings, mirroring a real extension install.
  mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(paths.agentDir, "extensions", "fixture-events.mjs"), FIXTURE_EXTENSION_SOURCE);
  writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ extensions: ["extensions/fixture-events.mjs"] }));
  writeFileSync(join(paths.cwd, "workflow.js"), "export const meta = { name: 'ignored' };\nreturn args.value;\n");

  const script = join(paths.root, "isolated-cli.mjs");
  const cliUrl = pathToFileURL(join(process.cwd(), "dist", "src", "cli.js")).href;
  writeFileSync(script, [
    `import { runCli } from ${JSON.stringify(cliUrl)};`,
    `const exit = await runCli(["run", "--script", "workflow.js", "--input", '{"value":"delivered"}'], { cwd: ${JSON.stringify(paths.cwd)}, agentDir: ${JSON.stringify(paths.agentDir)}, stderr: (text) => process.stderr.write(text) });`,
    "process.exitCode = exit;",
    "",
  ].join("\n"));

  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, HOME: paths.root, PI_CODING_AGENT_DIR: paths.agentDir, PI_OFFLINE: "1", HEADLESS_DELIVERY_LOG: paths.deliveryLog },
    });
    assert.equal(result.status, 0, `headless run failed: ${result.stderr}`);
    assert.equal(result.stdout, '"delivered"\n');

    const deliveries = readFileSync(paths.deliveryLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { channel: string; name: string; runId: string; state: string | null });
    const hookDeliveries = deliveries.filter((delivery) => delivery.channel === "hook");
    const hookNames = hookDeliveries.map((delivery) => delivery.name);
    const hookRunIds = new Set(hookDeliveries.map((delivery) => delivery.runId));

    const terminalState = hookDeliveries.find((delivery) => delivery.name === "workflow:run-state-changed" && delivery.state === "completed");
    assert.ok(terminalState, `no terminal run-state-changed hook delivery; got ${JSON.stringify(hookDeliveries)}`);
    assert.ok(hookNames.includes("workflow:run-completed"), `no run-completed hook delivery; got ${hookNames.join(", ")}`);
    assert.equal(hookRunIds.size, 1, `hook deliveries span multiple runs: ${[...hookRunIds].join(", ")}`);
    for (const delivery of deliveries) assert.match(delivery.name, /^workflow:run-/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
