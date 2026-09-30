# GIOT engine lab: current experimental round

## Purpose

Use the public fork to test native `pi-extensible-workflows` capabilities in
the private [giot-workflows](https://github.com/thegiot/giot-workflows) lab.
The private repository owns workflow recipes, the harness, experiment records,
and the overall vision. This round asks whether two workflows expose concrete
engine API gaps. It is an experiment, not a build-platform program.

The existing [baseline issue](https://github.com/thegiot/giot-workflows/issues/13)
is the context link. The current round is [epic #15](https://github.com/thegiot/pi-extensible-workflows/issues/15),
with [diagnostics #16](https://github.com/thegiot/pi-extensible-workflows/issues/16) and
[local Herdr #17](https://github.com/thegiot/pi-extensible-workflows/issues/17). Old issues 2–14 remain closed as moved work.

## Before changing the engine

First run one native piewf issue-to-PR workflow in the lab and record what the
current API supports. Record its result, then choose the next probe from observed friction.
`plan-trip` is another conditional lab experiment; it is not required before
an engine probe. Change the engine only for a demonstrated gap. Do not require a
generic kernel before either workflow can run.

## Probe: external diagnostics for generated workflow code

Ask whether diagnostics can identify a deliberate type or property error in
model-generated workflow code, guide an agent correction, and allow the final
code to execute under the actual engine. Capture residual runtime errors.

Keep the paths separate in the result:

- piewf host TypeScript and Node runtime;
- sandboxed workflow JavaScript;
- Pi 0.99.1 `@earendil-works/pi-codemode` JavaScript in QuickJS;
- `renderDeclarations` TypeScript output, which describes tools but does not
  compile code or provide TypeScript/LSP diagnostics.

Compare JavaScript using `checkJs` and JSDoc with a minimal TypeScript compile
path. Refresh compiler versions before the probe. Existing TypeScript 7 numeric
pins are not a version decision. Do not make the comparison select a path
automatically.

## Probe: local Herdr visibility

Use the existing piewf Herdr companion to check local visibility, session-node
to-result mapping, cancellation, and cleanup. A sound result may require no
code. If the probe proves a native gap, keep any change to one bounded patch.

Herdr 0.9.1 remote `--machine` support is a separate future probe after local
behavior is proven. Factory Herdr extraction is not a prerequisite.

## Evidence and exit

For each probe, record the repository SHA, actual dependency and tool versions,
exact commands, outcomes, and residual errors in the private lab. State whether
to adopt, reject, repeat, or mark the result inconclusive. No experiment has
been run as of the documented baseline; proposed commands or expectations do
not count as results.

The round is complete when each probe has an evidence-backed decision or
an explicit decision not to run it. It does
not build an adapter, Effect layer, generic kernel, remote runner, multi-issue
scheduler, dynamic architect, marketplace, or Factory Herdr integration. Link
later work to the decision that establishes its need. Preserve the Node.js
`>=22.19.0` baseline and existing npm workspace and lockfile contracts while
probing.

## Upstream

The fork baseline is `8fbd9aa5501ad4899a39e396090222c89df5ed78`; the recorded
upstream baseline is `c90e2451fbc03cec944d945cf154e0314bffeaaf`. These are
reference commits, not latest-version claims. Sync by inspecting upstream
changes and carrying isolated fork patches on a reviewed branch. Do not
wholesale-reset the fork or broadly port changes without a demonstrated gap.
