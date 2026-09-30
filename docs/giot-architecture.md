# GIOT workflow fork architecture

This fork evolves `vekexasia/pi-extensible-workflows` into a reusable workflow
platform for GIOT while keeping upstream synchronization practical.

## Goals

- Keep the durable workflow runtime, resume/checkpoint/budget semantics, agent
  lifecycle, roles, worktrees, and trajectory facilities inherited from
  `pi-extensible-workflows`.
- Use Bun 1.4.2 as the monorepo package manager and orchestration runtime for
  GIOT-owned packages and tooling.
- Keep code loaded directly by Pi compatible with the Node host used by Pi
  0.99.1. Bun ownership must not be inferred merely because Bun manages the
  monorepo.
- Introduce TypeScript 7 and Effect v4 progressively without creating a second
  workflow engine.
- Reuse `@thegiot/herdr` for Herdr 0.9.1 protocol/process mechanics behind a
  workflow-specific adapter.
- Build small composable workflow capabilities that can express both software
  delivery workflows and unrelated domains such as travel planning.

## Non-goals

- No big-bang rewrite of the upstream core.
- No duplicate persistence/resume engine in Effect.
- No domain-specific concepts such as GitHub issues, pull requests, hotels, or
  flights in the generic kernel.
- No Herdr pane/workspace identity as execution or mutation authority.

## Runtime boundary

```text
Bun 1.4.2 monorepo/tooling
        |
        +-- GIOT deterministic services (Effect v4 / TS7)
        |
        +-- workflow recipes
        |
        +-- Pi workflow adapter --------------------+
                                                    |
                                             Pi 0.99.1 / Node host
                                                    |
                                      pi-extensible-workflows runtime
                                                    |
                                      workflow <-> Herdr adapter
                                                    |
                                           @thegiot/herdr
                                                    |
                                             Herdr 0.9.1
```

The existing `@thegiot/herdr` package currently declares a Bun-only runtime
contract. The integration must therefore establish a reviewed compatibility
boundary before the Pi extension imports it directly. Acceptable outcomes are:

1. split the package into a Node-compatible protocol/client core plus an
   optional Bun transport, or
2. keep a Bun-side bridge/adaptor and communicate through a typed boundary.

The fork must not silently load Bun-only APIs inside a Node-hosted Pi extension.

## Ownership model

The platform follows one invariant:

> Model output proposes; deterministic runtime decides.

Agents may produce candidates, plans, findings, or recommendations. They do not
grant completion, publication, mutation, or authority by prose. Deterministic
runtime gates validate evidence and own state transitions.

Herdr supplies runtime mechanics and locators only. A pane, tab, workspace, or
agent name never grants domain authority.

## Effect v4 role

Effect is used for typed program semantics:

- `Schema` for input/output and JSON Schema derivation;
- typed error channels;
- `Context` / `Layer` for services;
- `Schedule` for retries/backoff;
- scopes/finalizers for resource safety;
- structured concurrency and interruption;
- test services and deterministic clocks.

The durable workflow lifecycle remains owned by `pi-extensible-workflows`.
Effect must not introduce competing resume/checkpoint/persistence semantics.

## Capability-first workflow surface

The reusable layer should converge on capabilities such as:

- research / search / fetch;
- agent execution;
- parallel / pipeline composition;
- review;
- verification;
- approval / checkpoint;
- budget;
- artifact production;
- isolated workspace;
- publication;
- clock / human interaction.

Domain packages adapt those capabilities:

```text
software: GitHubIssueSource, GitWorktreeWorkspace, TestVerification, PRPublication
travel:   FlightSearch, HotelSearch, MapSearch, TravelBudgetVerification
```

## Validation strategy

Two deliberately different vertical slices are required before generalizing an
Epic-like scheduler:

1. `develop-issue` / `develop-issues`;
2. `plan-trip`.

If both can be expressed without adding domain conditionals to the kernel, the
abstraction level is considered viable.

## Upstream policy

Changes to inherited upstream code should be minimized and isolated. Prefer new
GIOT packages/adapters over broad edits to upstream core. Every architectural
change should state whether it is:

- upstream-compatible and potentially upstreamable;
- GIOT-specific adapter/policy;
- temporary fork divergence.

The fork should retain a documented upstream remote and a repeatable upstream
sync procedure.
