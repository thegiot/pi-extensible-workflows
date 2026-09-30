# Epic: GIOT reusable workflow platform

## Objective

Evolve the fork into a reusable, capability-first workflow platform for GIOT
while preserving the durable orchestration strengths of
`pi-extensible-workflows` and keeping upstream synchronization practical.

The platform must support both software-factory workflows and unrelated
workflows such as constrained travel planning.

## Binding principles

- Fork conservatively; no big-bang rewrite.
- Bun-first, Node-compatible.
- One durable workflow engine: `pi-extensible-workflows`.
- Effect v4 is the typed semantics layer, not a competing persistence engine.
- Reuse `@thegiot/herdr` for Herdr 0.9.1 mechanics behind a reviewed adapter.
- Herdr locators are not authority.
- Model output proposes; deterministic runtime decides.
- Capability-first kernel; domain concepts stay in adapters/recipes.
- Preserve upstream test coverage and document intentional fork divergence.

## Planned child issues

### 1. Bootstrap Bun 1.4.2 monorepo and upstream-sync policy

**Goal:** make Bun the authoritative workspace/package-manager toolchain without
turning Pi-loaded code into Bun-only code.

**Acceptance**
- root declares `bun@1.4.2`;
- deterministic `bunfig.toml` is committed;
- install/lock strategy is documented and CI-verifiable;
- upstream remote/sync procedure is documented;
- inherited Node-based tests remain runnable.

### 2. Establish the Bun/Node/Pi runtime boundary

**Goal:** mechanically distinguish Bun-owned tooling/runtime from modules loaded
inside the Pi Node host.

**Acceptance**
- runtime compatibility matrix exists;
- no accidental use of `Bun.*` in Node-hosted Pi extension graphs;
- CI contains a Node load smoke for Pi-facing packages;
- Bun-only packages are explicit.

### 3. Introduce TypeScript 7 foundations progressively

**Goal:** use TypeScript 7.0.2 / tsgo for GIOT-owned foundations before
migrating inherited upstream packages.

**Acceptance**
- shared TS7 config exists;
- GIOT-owned packages check with TS7;
- upstream package migration is gated by compatibility proof;
- no silent weakening of strictness.

### 4. Integrate `@thegiot/herdr` behind a workflow adapter

**Goal:** eliminate duplicate Herdr mechanics while preserving workflow-specific
handoff/inspection semantics.

**Important constraint:** `@thegiot/herdr` currently declares a Bun-only
runtime contract, while the Pi Herdr extension is Node-hosted.

**Acceptance**
- reviewed compatibility design chooses either a Node-compatible client core +
  optional Bun transport, or a typed Bun-side bridge;
- workflow Herdr semantics depend on an interface, not CLI string construction;
- Herdr pane/workspace identity never grants domain authority;
- live handoff, inspection, cancellation and cleanup remain covered.

### 5. Add Effect v4 integration layer without a second workflow engine

**Goal:** provide Effect-backed services, errors, schemas, retries and resource
safety to workflow functions.

**Acceptance**
- Effect `Schema` can define workflow input/output and derive JSON Schema;
- typed errors map cleanly to workflow failures;
- `Context`/`Layer` expose deterministic services;
- `Schedule`/scopes/interruption are usable;
- persistence/resume/checkpoint ownership remains with piewf.

### 6. Define the capability-first workflow kernel

**Goal:** establish a small domain-neutral algebra rather than a library of
domain scripts.

Candidate capabilities:
- research/search/fetch;
- agent;
- parallel/pipeline;
- review;
- verification;
- approval/checkpoint;
- budget;
- artifact;
- isolated workspace;
- publication;
- clock/human interaction.

**Acceptance**
- domain entities such as GitHub issues, PRs, hotels and flights do not enter
  the kernel;
- candidate/gate semantics embody “model proposes; runtime decides”;
- APIs are typed and composable.

### 7. Add generic role/model routing on Pi 0.99 virtual models

**Goal:** keep workflow roles independent from concrete providers/models.

**Acceptance**
- roles request capability/quality/cost intent;
- virtual model aliases resolve to configured physical targets;
- routing policy can change without editing recipes;
- strong review floors and economical coordinator policies can be expressed
  without GIOT-specific hardcoding in core.

### 8. Extract reusable workflow primitives

**Goal:** implement the first stable primitives used by larger compositions.

Initial set:
- `research`;
- `agent`;
- `review`;
- `verify`;
- `checkpoint`;
- `budget`;
- `artifact`;
- `withWorkspace`.

**Acceptance**
- each primitive has typed IO/error contracts;
- primitives compose through the existing durable runtime;
- no primitive assumes a software domain.

### 9. Implement `develop-issue` recipe

**Goal:** express a single software issue delivery using the generic kernel.

Expected composition:
load source → derive contract → isolate workspace → implement → verify → review
→ produce/publish candidate.

**Acceptance**
- issue/Git/GitHub concepts live in the software adapter/recipe;
- deterministic gates own completion/publication;
- writer/reviewer authority is explicit;
- worktree lifecycle is deterministic and tested.

### 10. Implement `develop-issues` parallel composition

**Goal:** replace the prototype-style `develop-issues.ts` composition with a
typed reusable composition.

**Acceptance**
- multiple issue recipes run with bounded concurrency;
- failure of one child does not implicitly authorize merge/publication of it;
- approved candidates are combined through deterministic integration gates;
- durable resume does not rerun completed children unnecessarily.

### 11. Implement `plan-trip` non-software vertical slice

**Goal:** prove the kernel is genuinely generic.

Input should cover at least dates, origin/destination and budget. The workflow
should research transport/lodging/activities, enforce constraints, review the
candidate, and produce an itinerary artifact.

**Acceptance**
- uses the same generic primitives as software recipes;
- no travel-specific changes are required in the kernel;
- budget/constraint checks are deterministic where data permits;
- provenance for researched facts is retained.

### 12. Dogfood from `giot-factory` and assess Epic migration

**Goal:** integrate the new platform with GIOT rather than creating a parallel
unused framework.

**Acceptance**
- at least one bounded GIOT workflow runs through the new packages;
- compare current issue/epic orchestration with the new composition model;
- identify which current `pi-issue-*` / `pi-epic-*` responsibilities can
  migrate and which remain GIOT policy;
- no migration occurs solely to reduce file count: authority/evidence
  invariants must be preserved or strengthened.

## Epic exit criteria

- upstream sync remains repeatable;
- Bun workspace is authoritative without breaking Pi/Node compatibility;
- `@thegiot/herdr` is reused safely;
- Effect is usable without duplicate durable state;
- `develop-issue`, `develop-issues`, and `plan-trip` share the same kernel;
- GIOT dogfood demonstrates a credible path toward simplifying current Epic
  orchestration.
