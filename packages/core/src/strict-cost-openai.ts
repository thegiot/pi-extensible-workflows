import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { isCostCount, isCostTariff, STRICT_COST_MODEL, type ApprovedCostTariff, type CostCounters, type CostSettlement, type StrictCostLedger } from "./strict-cost.js";
import { WorkflowError, type CostProvenance, type WorkflowAgentSessionStats } from "./types.js";
import { object } from "./utils.js";

const BASE_URL = "https://api.openai.com/v1";
const ENDPOINT = `${BASE_URL}/chat/completions`;
const SDK_VERSION = "0.99.1";

export interface StrictCostOpenAI {
  readonly approvedTariff: ApprovedCostTariff;
  readonly apiKey: string;
  /** Trusted transport. If supplied it must dispatch only the received request. */
  readonly fetch?: typeof globalThis.fetch;
}

export function approveStrictCost(options: StrictCostOpenAI): StrictCostOpenAI {
  let matchingSDKs = false;
  try {
    const entry = import.meta.resolve("@earendil-works/pi-ai");
    const packageJson: unknown = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
    matchingSDKs = VERSION === SDK_VERSION && object(packageJson) && packageJson.version === SDK_VERSION;
  } catch { /* An unidentified SDK is outside the audited scope. */ }
  if (!matchingSDKs || !isCostTariff(options.approvedTariff) || typeof options.apiKey !== "string" || !options.apiKey.trim()) {
    throw new WorkflowError("COST_PROVENANCE_UNAVAILABLE", "Strict cost requires an approved tariff, explicit OpenAI credentials and supported Pi SDK versions");
  }
  const { source, input, cacheRead, output } = options.approvedTariff;
  return Object.freeze({ apiKey: options.apiKey, approvedTariff: Object.freeze({ source, input, cacheRead, output }), fetch: options.fetch ?? globalThis.fetch });
}

export const strictCostModel: Model<"openai-completions"> = {
  id: STRICT_COST_MODEL, name: "GPT-5.4 mini (2026-03-17)", provider: "openai", api: "openai-completions", baseUrl: BASE_URL, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 16_384,
};

export interface StrictCostSessionConfig {
  readonly options: StrictCostOpenAI;
  readonly ledger: StrictCostLedger;
  readonly agentId: string;
  readonly check: () => void;
  readonly signal: AbortSignal;
}

const requestKeys = new Set(["model", "messages", "tools", "n", "stream", "stream_options", "store", "max_tokens", "max_completion_tokens", "service_tier", "reasoning_effort"]);
function validMessage(value: unknown): boolean {
  if (!object(value) || typeof value.role !== "string" || !["system", "developer", "user", "assistant", "tool"].includes(value.role)) return false;
  if (typeof value.content === "string") return true;
  if (Array.isArray(value.content)) return value.content.every((part: unknown) => object(part) && part.type === "text" && typeof part.text === "string");
  return value.role === "assistant" && (value.content === null || value.content === undefined) && Array.isArray(value.tool_calls);
}

function guardedBody(value: unknown): boolean {
  return object(value) && Object.keys(value).every((key) => requestKeys.has(key)) &&
    value.model === STRICT_COST_MODEL && value.n === 1 && value.stream === true && value.service_tier === "default" && value.reasoning_effort === "none" &&
    value.store === false && object(value.stream_options) && value.stream_options.include_usage === true &&
    Object.keys(value.stream_options).length === 1 && Array.isArray(value.messages) && value.messages.every(validMessage) &&
    Array.isArray(value.tools) && value.tools.length === 1 && object(value.tools[0]) && value.tools[0].type === "function" &&
    object(value.tools[0].function) && value.tools[0].function.name === "workflow_result";
}

function rawCounters(value: unknown): CostCounters | undefined {
  if (!object(value) || !object(value.prompt_tokens_details)) return undefined;
  const { prompt_tokens: prompt, completion_tokens: output, total_tokens: total, prompt_tokens_details: promptDetails, completion_tokens_details: outputDetails } = value;
  if (!Object.keys(value).every((key) => ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"].includes(key))) return undefined;
  const cached = promptDetails.cached_tokens;
  const inputExtrasValid = Object.entries(promptDetails).every(([key, count]) => key === "cached_tokens" || ["audio_tokens", "cache_write_tokens"].includes(key) && count === 0);
  const outputExtrasValid = outputDetails == null || object(outputDetails) && Object.entries(outputDetails).every(([key, count]) =>
    ["audio_tokens", "reasoning_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"].includes(key) && count === 0);
  if (!inputExtrasValid || !outputExtrasValid || !isCostCount(prompt) || !isCostCount(output) || !isCostCount(total) || !isCostCount(cached) || cached > prompt || prompt + output !== total) return undefined;
  return { input: prompt - cached, cacheRead: cached, output };
}

export function strictCostStream(config: StrictCostSessionConfig) {
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let pending = false;
  let gap: string | undefined;
  const transport = config.options.fetch ?? globalThis.fetch;
  const provenance = (): CostProvenance => gap ? { status: "unknown", reason: gap } : { status: pending ? "pending" : "estimated", usd: cost };

  return {
    stats: (): WorkflowAgentSessionStats => ({ tokens: { input, output, cacheRead, cacheWrite: 0, total: input + output + cacheRead }, cost, costProvenance: provenance() }),
    stream: async (selected: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) => {
      const result = createAssistantMessageEventStream();
      let requestId: string | undefined;
      const request = { dispatched: false };
      let fetchAttempted = false;
      let counters: CostCounters | undefined;
      let providerId: string | undefined;
      let sawUsage = false;
      let failure: string | undefined;
      const protocolFailure = (reason: string): void => {
        failure ??= reason;
        if (request.dispatched) config.ledger.markUnknown(failure);
      };
      let assistant: AssistantMessage | undefined;
      const signal = options?.signal ? AbortSignal.any([options.signal, config.signal]) : config.signal;
      try {
        config.check();
        if (selected !== strictCostModel || signal.aborted) throw new Error("Strict cost request unavailable");
        const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
        const stream = streamSimple(strictCostModel, context, {
          apiKey: config.options.apiKey, signal, maxRetries: 0, cacheRetention: "none",
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          onPayload(payload) {
            return object(payload) ? { ...payload, n: 1, service_tier: "default", reasoning_effort: "none" } : payload;
          },
          async fetch(url, init) {
            if (fetchAttempted) { protocolFailure("unexpected_retry"); throw new Error("Unexpected strict cost retry"); }
            fetchAttempted = true;
            let body: unknown;
            try { body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined; } catch { /* Rejected below. */ }
            if (url !== ENDPOINT || init?.method !== "POST" || !guardedBody(body)) {
              failure = "request_outside_coverage";
              throw new Error("Strict cost request is outside the approved scope");
            }
            const headers = new Headers(init.headers);
            if (headers.get("authorization") !== `Bearer ${config.options.apiKey}`) {
              failure = "request_auth_mismatch";
              throw new Error("Strict cost request has unexpected credentials");
            }
            headers.delete("openai-organization");
            headers.delete("openai-project");
            requestId = await config.ledger.begin(config.agentId, config.check);
            pending = true;
            config.ledger.checkAdmission();
            config.check();
            if (signal.aborted || init.signal?.aborted) throw new Error("Strict cost request cancelled before dispatch");
            request.dispatched = true;
            const response = await transport(url, { ...init, headers, redirect: "error" }).catch((error: unknown) => {
              protocolFailure(signal.aborted ? "aborted_request" : "request_failed");
              throw error;
            });
            if (response.redirected || response.status >= 300 && response.status < 400) {
              protocolFailure("redirect");
              throw new Error("Strict cost response redirected");
            }
            if (!response.ok) protocolFailure("request_failed");
            return response;
          },
          onProviderStreamEvent(event) {
            if (!object(event) || event.object !== "chat.completion.chunk" || typeof event.id !== "string" || !event.id ||
              event.model !== STRICT_COST_MODEL || providerId !== undefined && event.id !== providerId ||
              event.service_tier !== undefined && event.service_tier !== "default") {
              protocolFailure("response_outside_coverage");
              return;
            }
            providerId = event.id;
            if (sawUsage) { protocolFailure("unexpected_chunk_after_usage"); return; }
            if (event.usage == null) return;
            sawUsage = true;
            if (event.service_tier !== "default" || !Array.isArray(event.choices) || event.choices.length !== 0 || !(counters = rawCounters(event.usage))) {
              protocolFailure("invalid_usage");
            }
          },
        });
        assistant = await stream.result();
      } catch { /* Classify by actual dispatch and validated usage below. */ }

      let settlement: CostSettlement | undefined;
      if (requestId !== undefined) {
        if (!request.dispatched) settlement = { status: "not_dispatched" };
        else if (!failure && counters && assistant && assistant.stopReason !== "error" && assistant.stopReason !== "aborted") settlement = { status: "estimated", counters };
        else settlement = { status: "unknown", reason: failure ?? (signal.aborted ? "aborted_request" : assistant?.stopReason === "error" ? "request_failed" : "missing_usage") };
        try { await config.ledger.settle(requestId, settlement); }
        catch { settlement = { status: "unknown", reason: "evidence_write_failed" }; }
        pending = false;
      }
      if (settlement?.status === "estimated" && assistant) {
        const { input: usedInput, output: usedOutput, cacheRead: usedCacheRead } = settlement.counters;
        const tariff = config.ledger.tariff;
        const usageCost = { input: usedInput * tariff.input / 1e6, output: usedOutput * tariff.output / 1e6, cacheRead: usedCacheRead * tariff.cacheRead / 1e6, cacheWrite: 0 };
        const total = usageCost.input + usageCost.output + usageCost.cacheRead;
        input += usedInput;
        output += usedOutput;
        cacheRead += usedCacheRead;
        if (Number.isFinite(cost + total)) cost += total;
        else gap ??= "estimate_overflow";
        if (assistant.stopReason === "stop" || assistant.stopReason === "length" || assistant.stopReason === "toolUse") {
          result.push({ type: "done", reason: assistant.stopReason, message: { ...assistant, usage: { input: usedInput, output: usedOutput, cacheRead: usedCacheRead, cacheWrite: 0, totalTokens: usedInput + usedOutput + usedCacheRead, cost: { ...usageCost, total: Number.isFinite(total) ? total : 0 } } } });
        }
      } else {
        if (settlement?.status === "unknown") gap ??= settlement.reason;
        const errorMessage = gap ?? failure ?? "request_not_dispatched";
        const error: AssistantMessage = {
          role: "assistant", content: [], api: strictCostModel.api, provider: strictCostModel.provider, model: strictCostModel.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          timestamp: Date.now(), stopReason: "error", errorMessage: `Strict cost: ${errorMessage}`,
        };
        result.push({ type: "error", reason: "error", error });
      }
      result.end();
      return result;
    },
  };
}
