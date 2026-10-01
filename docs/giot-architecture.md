# GIOT engine lab

This public fork answers a narrow question: which changes, if any, does
GIOT need in the native `pi-extensible-workflows` engine? The private
[giot-workflows](https://github.com/thegiot/giot-workflows) repository owns
recipes, the test harness, experiment evidence, and the broader product plan.
This fork changes only when a proven workflow cannot be expressed through the
engine's existing API.

## Current baseline

- Fork baseline: `8fbd9aa5501ad4899a39e396090222c89df5ed78`.
- Upstream reference: `vekexasia/pi-extensible-workflows` 5.18.0 at
  `c90e2451fbc03cec944d945cf154e0314bffeaaf`. These are recorded baselines,
  not claims about the latest upstream release.
- Runtime baseline: Node.js `>=22.19.0`, as declared in the package manifest.
  The repository uses npm workspace scripts and a checked-in npm lockfile.
  Existing Bun package metadata does not set the direction for this experiment.
- First prove a native piewf issue-to-PR workflow in the lab. Record
  its result, then choose a probe from the observed friction. `plan-trip` is
  another conditional lab experiment, not a gate before an engine probe.

The [parent baseline issue](https://github.com/thegiot/giot-workflows/issues/13)
tracks the private lab context. The current engine round is
[epic #15](https://github.com/thegiot/pi-extensible-workflows/issues/15), with
[diagnostics #16](https://github.com/thegiot/pi-extensible-workflows/issues/16) and
[local Herdr #17](https://github.com/thegiot/pi-extensible-workflows/issues/17). Old issues 2–14 remain closed as
moved work; they are not a live implementation backlog.

## Current experimental round

### External diagnostics for generated workflow code

Test whether model-generated workflow code can receive useful external
diagnostics, let an agent correct an intentional type or property error, and
then execute the corrected code with the actual engine. Report any remaining
runtime errors.

Keep the runtimes distinct in the evidence:

- piewf itself is hosted by Pi's TypeScript/Node path;
- workflow bodies run as sandboxed JavaScript;
- Pi 0.99.1 `@earendil-works/pi-codemode` runs JavaScript in QuickJS;
- its `renderDeclarations` output describes tools in TypeScript, but does not
  compile workflow code or provide LSP diagnostics.

Compare JavaScript with `checkJs` and JSDoc against a minimal TypeScript
compile-and-run path. Refresh compiler and tooling versions before choosing
one; do not inherit unsupported TypeScript 7 numeric pins. The probe compares
options and does not choose automatically.

### Local Herdr session visibility

Check whether the existing piewf Herdr companion provides local visibility,
maps a session node to its result, and handles cancellation and cleanup. The
probe may conclude that no code change is needed, or identify one bounded patch
to a demonstrated native gap.

Prove the local flow first. Herdr 0.9.1 remote `--machine` support is a
separate future probe. Extracting Factory's Herdr integration is not a
prerequisite.

## Evidence and decisions

For each probe, record the tested repository SHA, actual tool versions, exact
commands, results, residual errors, and one decision: adopt, reject, repeat,
or inconclusive. No experiment has been run as of these recorded baselines.
Proposals and documentation do not count as execution evidence.

The round ends with those decisions. It does not require an adapter, generic
kernel, Effect layer, remote execution, multi-issue scheduler, dynamic
architect, marketplace, or Factory Herdr extraction. Revisit those topics only
when a linked workflow establishes a concrete need.

## Upstream sync

The fork is based on upstream commit
`c90e2451fbc03cec944d945cf154e0314bffeaaf`; it is not assumed to be current.
Before syncing, inspect upstream history and the diff against the fork. Carry
isolated fork patches forward on a reviewed branch and run the checks relevant
to those changes. Do not wholesale-reset or broadly port upstream changes.
Keep every divergence tied to an observed native API gap and its private lab
evidence.
