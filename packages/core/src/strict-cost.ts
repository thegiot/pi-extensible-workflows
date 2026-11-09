import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkflowError, type CostProvenance } from "./types.js";
import { object, SerialLane } from "./utils.js";

export const STRICT_COST_SNAPSHOT_VERSION = 7;
const FILE = "strict-cost.jsonl";

export interface ApprovedCostTariff {
  readonly source: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface CostCounters { input: number; cacheRead: number; output: number }
export type CostSettlement =
  | { status: "estimated"; counters: CostCounters }
  | { status: "unknown"; reason: string }
  | { status: "not_dispatched" };

type Entry = { kind: "intent"; id: string; agentId: string } | { kind: "settlement"; id: string; settlement: CostSettlement };

export function isCostTariff(value: unknown): value is ApprovedCostTariff {
  return object(value) && typeof value.source === "string" && value.source.trim().length > 0 &&
    value.source.length <= 500 && [value.input, value.cacheRead, value.output].every(nonnegative);
}

function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function isCostCount(value: unknown): value is number { return nonnegative(value) && Number.isSafeInteger(value); }
export function decodeCostProvenance(value: unknown): CostProvenance | undefined {
  if (!object(value)) return undefined;
  if ((value.status === "estimated" || value.status === "pending") && nonnegative(value.usd)) return { status: value.status, usd: value.usd };
  if (value.status === "unknown" && typeof value.reason === "string" && value.reason.length > 0) return { status: "unknown", reason: value.reason };
  return undefined;
}

function estimatedUsd(tariff: ApprovedCostTariff, counts: CostCounters): number {
  return (counts.input * tariff.input + counts.cacheRead * tariff.cacheRead + counts.output * tariff.output) / 1e6;
}

class RequestTotals {
  readonly pending = new Set<string>();
  #seen = new Set<string>();
  #subtotal = 0;
  gap: string | undefined;

  apply(entry: Entry, tariff: ApprovedCostTariff): boolean {
    if (entry.kind === "intent") {
      if (this.#seen.has(entry.id)) return false;
      this.#seen.add(entry.id);
      this.pending.add(entry.id);
      return true;
    }
    if (!this.pending.delete(entry.id)) return false;
    const result = entry.settlement;
    if (result.status === "unknown") this.gap ??= result.reason;
    if (result.status === "estimated") {
      const total = this.#subtotal + estimatedUsd(tariff, result.counters);
      if (Number.isFinite(total)) this.#subtotal = total;
      else this.gap ??= "estimate_overflow";
    }
    return true;
  }

  snapshot(recovery = false): CostProvenance {
    if (this.gap) return { status: "unknown", reason: this.gap };
    if (this.pending.size && recovery) return { status: "unknown", reason: "unsettled_request" };
    return { status: this.pending.size ? "pending" : "estimated", usd: this.#subtotal };
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function append(path: string, entry: unknown, create = false): Promise<void> {
  const handle = await open(path, create ? "ax" : "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

export class StrictCostLedger {
  #lane = new SerialLane();
  #totals = new RequestTotals();
  #closed = false;
  #storageFailed = false;
  #sealed = false;
  private constructor(readonly path: string, readonly tariff: ApprovedCostTariff, readonly observe: (value: CostProvenance) => void) {}

  static async create(directory: string, tariff: ApprovedCostTariff, observe: (value: CostProvenance) => void): Promise<StrictCostLedger> {
    const path = join(directory, FILE);
    const frozen = Object.freeze({ source: tariff.source, input: tariff.input, cacheRead: tariff.cacheRead, output: tariff.output });
    await append(path, { version: 1, provider: "openai", api: "openai-completions", model: STRICT_COST_MODEL, tier: "default", tariff: frozen }, true);
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
    return new StrictCostLedger(path, frozen, observe);
  }

  checkAdmission(): void {
    if (this.#closed || this.#totals.gap) throw new WorkflowError("BUDGET_EXHAUSTED", "Strict estimated cost does not allow further requests");
  }

  async begin(agentId: string, check: () => void = () => undefined): Promise<string> {
    return this.#lane.run(async () => {
      this.checkAdmission();
      check();
      const id = randomUUID();
      await this.#record({ kind: "intent", id, agentId });
      return id;
    });
  }

  markUnknown(reason: string): void {
    if (this.#totals.gap) return;
    this.#totals.gap = reason;
    this.observe(this.#totals.snapshot());
  }

  settle(id: string, settlement: CostSettlement): Promise<void> {
    if (settlement.status === "unknown") this.markUnknown(settlement.reason);
    return this.#lane.run(() => this.#record({ kind: "settlement", id, settlement }));
  }

  async #record(entry: Entry): Promise<void> {
    try {
      if (this.#storageFailed) throw new Error("Strict cost evidence store failed");
      await append(this.path, entry);
      if (!this.#totals.apply(entry, this.tariff)) throw new Error("Unexpected strict cost request identity");
    } catch {
      this.#storageFailed = true;
      this.#closed = true;
      this.#totals.gap ??= "evidence_write_failed";
      this.observe(this.#totals.snapshot());
      throw new WorkflowError("BUDGET_EXHAUSTED", "Strict cost evidence could not be saved");
    }
    this.observe(this.#totals.snapshot());
  }

  snapshot(): CostProvenance { return this.#totals.snapshot(); }

  fence(): void { this.#closed = true; }

  async close(): Promise<void> {
    this.fence();
    await this.#lane.run(async () => {
      if (this.#totals.pending.size) this.markUnknown("unsettled_request");
      if (this.#sealed || this.#storageFailed || this.#totals.gap) return;
      try {
        await append(this.path, { kind: "closed" });
        this.#sealed = true;
      }
      catch {
        this.#storageFailed = true;
        this.#totals.gap = "evidence_write_failed";
        this.observe(this.#totals.snapshot());
      }
    });
  }
}

export const STRICT_COST_MODEL = "gpt-5.4-mini-2026-03-17";

function decodeEntry(value: unknown): Entry | undefined {
  if (!object(value) || typeof value.id !== "string") return undefined;
  if (value.kind === "intent" && typeof value.agentId === "string") return { kind: "intent", id: value.id, agentId: value.agentId };
  if (value.kind !== "settlement" || !object(value.settlement)) return undefined;
  const settlement = value.settlement;
  if (settlement.status === "not_dispatched") return { kind: "settlement", id: value.id, settlement: { status: settlement.status } };
  if (settlement.status === "unknown" && typeof settlement.reason === "string" && settlement.reason) return { kind: "settlement", id: value.id, settlement: { status: settlement.status, reason: settlement.reason } };
  const counts = settlement.counters;
  if (settlement.status !== "estimated" || !object(counts) || !isCostCount(counts.input) || !isCostCount(counts.output) || !isCostCount(counts.cacheRead)) return undefined;
  return { kind: "settlement", id: value.id, settlement: { status: settlement.status, counters: { input: counts.input, cacheRead: counts.cacheRead, output: counts.output } } };
}

export async function readStrictCost(directory: string): Promise<CostProvenance> {
  try {
    const contents = await readFile(join(directory, FILE), "utf8");
    const lines = contents.split("\n");
    if (lines.pop() !== "") throw new Error("Incomplete strict cost record");
    const header: unknown = JSON.parse(lines.shift() ?? "");
    if (!object(header) || header.version !== 1 || header.model !== STRICT_COST_MODEL || header.provider !== "openai" || header.api !== "openai-completions" || header.tier !== "default" || !isCostTariff(header.tariff)) throw new Error("Invalid strict cost header");
    const totals = new RequestTotals();
    let closed = false;
    for (const line of lines) {
      const raw: unknown = JSON.parse(line);
      if (closed) throw new Error("Unexpected entry after strict cost closure");
      if (object(raw) && raw.kind === "closed") { closed = true; continue; }
      const entry = decodeEntry(raw);
      if (!entry || !totals.apply(entry, header.tariff)) throw new Error("Invalid strict cost entry");
    }
    const snapshot = totals.snapshot(true);
    if (!closed && snapshot.status === "estimated") return { status: "unknown", reason: "unclosed_evidence" };
    return snapshot;
  } catch {
    return { status: "unknown", reason: "evidence_unavailable" };
  }
}
