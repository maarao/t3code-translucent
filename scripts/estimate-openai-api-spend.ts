#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export interface PricingRates {
  readonly inputPerMillionUsd: number;
  readonly cachedInputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

export interface UsageCostSummary extends TokenUsage {
  readonly uncachedInputTokens: number;
  readonly estimatedCostUsd: number;
}

export interface TimeWindow {
  readonly start: string;
  readonly end: string;
}

interface T3ActivityRow {
  readonly activityId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly threadCreatedAt: string;
  readonly activityCreatedAt: string;
  readonly pendingMessageId: string | null;
  readonly threadModelSelectionJson: string | null;
  readonly payloadJson: string;
}

interface TurnStartEventRow {
  readonly payloadJson: string;
}

interface ReviewThreadRow {
  readonly id: string;
  readonly rolloutPath: string;
  readonly createdAt: number;
  readonly source: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

interface ParsedReviewSession {
  readonly id: string;
  readonly rolloutPath: string;
  readonly createdAt: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly usage: TokenUsage;
}

interface T3SpendSummary {
  readonly threads: number;
  readonly usageEvents: number;
  readonly earliestThread: {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
  };
  readonly window: TimeWindow;
  readonly usage: UsageCostSummary;
  readonly byModel: Record<
    string,
    { readonly threads: number; readonly usageEvents: number; readonly usage: UsageCostSummary }
  >;
}

interface ReviewSpendSummary {
  readonly sessions: number;
  readonly skippedMissingRollout: number;
  readonly skippedWithoutUsage: number;
  readonly windowStrategy: "same-as-t3" | "all";
  readonly window?: TimeWindow;
  readonly usage: UsageCostSummary;
  readonly byModel: Record<string, { readonly sessions: number; readonly usage: UsageCostSummary }>;
}

interface SpendReport {
  readonly generatedAt: string;
  readonly assumptions: {
    readonly pricingMode: "recorded-models" | "forced-model";
    readonly forcedModel?: string;
    readonly t3PricingModel?: string;
    readonly reviewWindow: "same-as-t3" | "all";
  };
  readonly t3Code: T3SpendSummary;
  readonly codexReviews: ReviewSpendSummary;
  readonly combined: UsageCostSummary;
}

export const MODEL_PRICING = {
  "gpt-5.5": {
    inputPerMillionUsd: 5,
    cachedInputPerMillionUsd: 0.5,
    outputPerMillionUsd: 30,
  },
  "gpt-5.4": {
    inputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 0.25,
    outputPerMillionUsd: 15,
  },
  "gpt-5.3-codex": {
    inputPerMillionUsd: 1.75,
    cachedInputPerMillionUsd: 0.175,
    outputPerMillionUsd: 14,
  },
} as const satisfies Record<string, PricingRates>;

function printUsage(): void {
  console.log(`Estimate T3 Code thread spend plus Codex review spend using local sqlite state.

Usage:
  node scripts/estimate-openai-api-spend.ts [options]

Options:
  --json                         Print machine-readable JSON.
  --last-days <days>             Use a rolling window ending now.
  --model <model>                Price T3 Code and review usage as one model.
  --window-start <timestamp>     Restrict T3 usage to a start timestamp.
  --window-end <timestamp>       Restrict T3 usage to an end timestamp.
  --review-window <mode>         "same-as-t3" (default) or "all".
  --t3-pricing-model <model>     Price only T3 Code usage as one model.
  --t3-state-db <path>           Override T3 Code sqlite path.
  --codex-state-db <path>        Override Codex sqlite path.
  --help                         Show this help.
`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric '${key}' field.`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric '${key}' field when present.`);
  }
  return value;
}

function normalizeTimestamp(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp '${input}'.`);
  }
  return date.toISOString();
}

function asDateMilliseconds(timestamp: string): number {
  const value = new Date(timestamp).getTime();
  if (Number.isNaN(value)) {
    throw new Error(`Invalid timestamp '${timestamp}'.`);
  }
  return value;
}

export function resolveLastDaysWindow(
  lastDays: number,
  now = new Date(),
): {
  readonly start: string;
  readonly end: string;
} {
  if (!Number.isInteger(lastDays) || lastDays <= 0) {
    throw new Error(`Invalid --last-days '${lastDays}'. Use a positive integer.`);
  }

  const end = new Date(now);
  if (Number.isNaN(end.getTime())) {
    throw new Error("Invalid current time.");
  }

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lastDays);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export function isDedicatedReviewSource(source: string): boolean {
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) && parsed.subagent === "review";
  } catch {
    return false;
  }
}

export function calculateUsageCost(usage: TokenUsage, pricing: PricingRates): UsageCostSummary {
  const inputTokens = Math.max(0, Math.trunc(usage.inputTokens));
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, Math.trunc(usage.cachedInputTokens)));
  const outputTokens = Math.max(0, Math.trunc(usage.outputTokens));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const estimatedCostUsd =
    (uncachedInputTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillionUsd +
    (outputTokens / 1_000_000) * pricing.outputPerMillionUsd;

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    estimatedCostUsd,
  };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

export function readModelFromSelectionJson(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    return null;
  }

  const model = parsed.model;
  return typeof model === "string" && model.trim().length > 0 ? model : null;
}

export function resolveEffectiveWindow(
  observed: TimeWindow,
  explicit?: {
    readonly start?: string;
    readonly end?: string;
  },
): TimeWindow {
  return {
    start: explicit?.start ?? observed.start,
    end: explicit?.end ?? observed.end,
  };
}

function resolveKnownPricing(model: string): PricingRates {
  const pricing = MODEL_PRICING[model as keyof typeof MODEL_PRICING];
  if (pricing === undefined) {
    throw new Error(
      `No pricing configured for '${model}'. Known models: ${Object.keys(MODEL_PRICING).join(", ")}`,
    );
  }
  return pricing;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function resolveDefaultPaths(): {
  readonly t3StateDb: string;
  readonly codexStateDb: string;
} {
  const home = homedir();
  return {
    t3StateDb: join(home, ".t3", "userdata", "state.sqlite"),
    codexStateDb: join(home, ".codex", "state_5.sqlite"),
  };
}

function readT3Payload(row: T3ActivityRow): TokenUsage {
  const parsed: unknown = JSON.parse(row.payloadJson);
  if (!isRecord(parsed)) {
    throw new Error(`Activity ${row.activityId} has a non-object payload.`);
  }
  return {
    inputTokens: readRequiredNumber(parsed, "inputTokens"),
    cachedInputTokens: readOptionalNumber(parsed, "cachedInputTokens"),
    outputTokens: readRequiredNumber(parsed, "outputTokens"),
  };
}

function readTurnStartModelSelections(db: DatabaseSync): Map<string, string> {
  const rows = asRows<Array<TurnStartEventRow>>(
    db
      .prepare(`
      SELECT payload_json AS payloadJson
      FROM orchestration_events
      WHERE event_type = 'thread.turn-start-requested'
    `)
      .all(),
  );

  const output = new Map<string, string>();
  for (const row of rows) {
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (!isRecord(parsed)) {
      continue;
    }

    const threadId = parsed.threadId;
    const messageId = parsed.messageId;
    const modelSelection = parsed.modelSelection;
    if (
      typeof threadId !== "string" ||
      typeof messageId !== "string" ||
      !isRecord(modelSelection) ||
      typeof modelSelection.model !== "string"
    ) {
      continue;
    }

    output.set(`${threadId}:${messageId}`, modelSelection.model);
  }

  return output;
}

function resolveT3ActivityModel(
  row: T3ActivityRow,
  turnStartModelSelections: ReadonlyMap<string, string>,
): string {
  if (row.pendingMessageId !== null) {
    const turnModel = turnStartModelSelections.get(`${row.threadId}:${row.pendingMessageId}`);
    if (turnModel !== undefined) {
      return turnModel;
    }
  }

  const threadModel = readModelFromSelectionJson(row.threadModelSelectionJson);
  if (threadModel !== null) {
    return threadModel;
  }

  throw new Error(`Could not resolve model for T3 Code activity ${row.activityId}.`);
}

function asRows<T>(value: unknown): T {
  return value as T;
}

function loadT3SpendSummary(
  dbPath: string,
  forcedModel: string | undefined,
  explicitWindow?: {
    readonly start?: string;
    readonly end?: string;
  },
): T3SpendSummary {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let sql = `
      SELECT
        a.activity_id AS activityId,
        a.thread_id AS threadId,
        t.title AS threadTitle,
        t.created_at AS threadCreatedAt,
        a.created_at AS activityCreatedAt,
        pt.pending_message_id AS pendingMessageId,
        t.model_selection_json AS threadModelSelectionJson,
        a.payload_json AS payloadJson
      FROM projection_thread_activities a
      INNER JOIN projection_threads t ON t.thread_id = a.thread_id
      LEFT JOIN projection_turns pt ON pt.thread_id = a.thread_id AND pt.turn_id = a.turn_id
      WHERE a.kind = 'context-window.updated'
    `;

    const params: Record<string, string> = {};
    if (explicitWindow?.start !== undefined) {
      sql += " AND a.created_at >= $windowStart";
      params.$windowStart = explicitWindow.start;
    }
    if (explicitWindow?.end !== undefined) {
      sql += " AND a.created_at <= $windowEnd";
      params.$windowEnd = explicitWindow.end;
    }
    sql += " ORDER BY a.created_at ASC";

    const rows = asRows<Array<T3ActivityRow>>(db.prepare(sql).all(params));
    const firstRow = rows[0];
    const lastRow = rows.at(-1);
    if (firstRow === undefined || lastRow === undefined) {
      throw new Error("No T3 Code context-window usage rows were found in the requested window.");
    }

    const observedWindow: TimeWindow = {
      start: firstRow.activityCreatedAt,
      end: lastRow.activityCreatedAt,
    };
    const window = resolveEffectiveWindow(observedWindow, explicitWindow);

    const threadIds = new Set<string>();
    const byModelUsage = new Map<
      string,
      { usageEvents: number; usage: TokenUsage; threadIds: Set<string> }
    >();
    let earliestThread = {
      id: firstRow.threadId,
      title: firstRow.threadTitle,
      createdAt: firstRow.threadCreatedAt,
    };
    const turnStartModelSelections = readTurnStartModelSelections(db);

    for (const row of rows) {
      const rowUsage = readT3Payload(row);
      const model = forcedModel ?? resolveT3ActivityModel(row, turnStartModelSelections);
      resolveKnownPricing(model);

      threadIds.add(row.threadId);

      const existing = byModelUsage.get(model) ?? {
        usageEvents: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
        },
        threadIds: new Set<string>(),
      };
      existing.threadIds.add(row.threadId);
      byModelUsage.set(model, {
        usageEvents: existing.usageEvents + 1,
        usage: addTokenUsage(existing.usage, rowUsage),
        threadIds: existing.threadIds,
      });

      if (row.threadCreatedAt < earliestThread.createdAt) {
        earliestThread = {
          id: row.threadId,
          title: row.threadTitle,
          createdAt: row.threadCreatedAt,
        };
      }
    }

    const byModel = Object.fromEntries(
      Array.from(byModelUsage.entries()).map(([model, value]) => [
        model,
        {
          threads: value.threadIds.size,
          usageEvents: value.usageEvents,
          usage: calculateUsageCost(value.usage, resolveKnownPricing(model)),
        },
      ]),
    );

    return {
      threads: threadIds.size,
      usageEvents: rows.length,
      earliestThread,
      window,
      usage: calculateCombinedUsage(Object.values(byModel)),
      byModel,
    };
  } finally {
    db.close();
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readReviewUsage(rolloutPath: string): Promise<TokenUsage | null> {
  const stream = createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let usage: TokenUsage | null = null;

  try {
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || parsed.type !== "event_msg") {
        continue;
      }

      const payload = parsed.payload;
      if (!isRecord(payload) || payload.type !== "token_count") {
        continue;
      }

      const info = payload.info;
      if (!isRecord(info)) {
        continue;
      }

      const totalTokenUsage = info.total_token_usage;
      if (!isRecord(totalTokenUsage)) {
        continue;
      }

      usage = {
        inputTokens: readRequiredNumber(totalTokenUsage, "input_tokens"),
        cachedInputTokens: readOptionalNumber(totalTokenUsage, "cached_input_tokens"),
        outputTokens: readRequiredNumber(totalTokenUsage, "output_tokens"),
      };
    }
  } finally {
    lines.close();
    stream.close();
  }

  return usage;
}

async function loadReviewSessions(
  dbPath: string,
  windowStrategy: "same-as-t3" | "all",
  window?: TimeWindow,
): Promise<
  ReadonlyArray<ParsedReviewSession> & {
    readonly skippedMissingRollout: number;
    readonly skippedWithoutUsage: number;
  }
> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let skippedMissingRollout = 0;
  let skippedWithoutUsage = 0;

  try {
    const rows = asRows<Array<ReviewThreadRow>>(
      db
        .prepare(`
        SELECT
          id,
          rollout_path AS rolloutPath,
          created_at AS createdAt,
          source,
          model,
          reasoning_effort AS reasoningEffort
        FROM threads
        WHERE source LIKE '%review%'
        ORDER BY created_at ASC
      `)
        .all(),
    );

    const output: ParsedReviewSession[] = [];
    const startMs = window?.start !== undefined ? asDateMilliseconds(window.start) : null;
    const endMs = window?.end !== undefined ? asDateMilliseconds(window.end) : null;

    for (const row of rows) {
      if (!isDedicatedReviewSource(row.source)) {
        continue;
      }

      const createdAt = new Date(row.createdAt * 1000).toISOString();
      const createdAtMs = row.createdAt * 1000;
      if (windowStrategy === "same-as-t3") {
        if (startMs !== null && createdAtMs < startMs) {
          continue;
        }
        if (endMs !== null && createdAtMs > endMs) {
          continue;
        }
      }

      const rolloutPath = resolve(row.rolloutPath);
      if (!(await fileExists(rolloutPath))) {
        skippedMissingRollout += 1;
        continue;
      }

      const usage = await readReviewUsage(rolloutPath);
      if (usage === null) {
        skippedWithoutUsage += 1;
        continue;
      }

      if (row.model === null || row.model.trim().length === 0) {
        throw new Error(`Review session ${row.id} is missing its model.`);
      }

      output.push({
        id: row.id,
        rolloutPath,
        createdAt,
        model: row.model,
        reasoningEffort: row.reasoningEffort,
        usage,
      });
    }

    return Object.assign(output, {
      skippedMissingRollout,
      skippedWithoutUsage,
    });
  } finally {
    db.close();
  }
}

async function loadReviewSpendSummary(
  dbPath: string,
  windowStrategy: "same-as-t3" | "all",
  window?: TimeWindow,
  forcedModel?: string,
): Promise<ReviewSpendSummary> {
  const sessions = await loadReviewSessions(dbPath, windowStrategy, window);

  const byModelUsage = new Map<string, { sessions: number; usage: TokenUsage }>();

  for (const session of sessions) {
    const model = forcedModel ?? session.model;
    resolveKnownPricing(model);

    const existing = byModelUsage.get(model) ?? {
      sessions: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    };

    byModelUsage.set(model, {
      sessions: existing.sessions + 1,
      usage: addTokenUsage(existing.usage, session.usage),
    });
  }

  const byModel = Object.fromEntries(
    Array.from(byModelUsage.entries()).map(([model, value]) => [
      model,
      {
        sessions: value.sessions,
        usage: calculateUsageCost(value.usage, resolveKnownPricing(model)),
      },
    ]),
  );

  return {
    sessions: sessions.length,
    skippedMissingRollout: sessions.skippedMissingRollout,
    skippedWithoutUsage: sessions.skippedWithoutUsage,
    windowStrategy,
    ...(windowStrategy === "same-as-t3" && window !== undefined ? { window } : {}),
    usage: calculateCombinedUsage(Object.values(byModel)),
    byModel,
  };
}

function calculateCombinedUsage(
  summaries: ReadonlyArray<{ readonly usage: UsageCostSummary }>,
): UsageCostSummary {
  let totalUsage: TokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let estimatedCostUsd = 0;

  for (const summary of summaries) {
    totalUsage = addTokenUsage(totalUsage, summary.usage);
    estimatedCostUsd += summary.usage.estimatedCostUsd;
  }

  return {
    inputTokens: totalUsage.inputTokens,
    cachedInputTokens: totalUsage.cachedInputTokens,
    uncachedInputTokens: totalUsage.inputTokens - totalUsage.cachedInputTokens,
    outputTokens: totalUsage.outputTokens,
    estimatedCostUsd,
  };
}

async function createReport(options: {
  readonly t3StateDb: string;
  readonly codexStateDb: string;
  readonly forcedModel?: string;
  readonly t3PricingModel?: string;
  readonly reviewWindow: "same-as-t3" | "all";
  readonly lastDays?: number;
  readonly windowStart?: string;
  readonly windowEnd?: string;
}): Promise<SpendReport> {
  if (options.forcedModel !== undefined) {
    resolveKnownPricing(options.forcedModel);
  }
  if (options.t3PricingModel !== undefined) {
    resolveKnownPricing(options.t3PricingModel);
  }

  const explicitWindow =
    options.lastDays !== undefined
      ? resolveLastDaysWindow(options.lastDays)
      : {
          ...(options.windowStart !== undefined
            ? { start: normalizeTimestamp(options.windowStart) }
            : {}),
          ...(options.windowEnd !== undefined
            ? { end: normalizeTimestamp(options.windowEnd) }
            : {}),
        };

  const t3Code = loadT3SpendSummary(
    options.t3StateDb,
    options.forcedModel ?? options.t3PricingModel,
    explicitWindow,
  );
  const reviewWindow = options.reviewWindow === "same-as-t3" ? t3Code.window : undefined;
  const rawReviewSummary = await loadReviewSpendSummary(
    options.codexStateDb,
    options.reviewWindow,
    reviewWindow,
    options.forcedModel,
  );

  const combined = {
    inputTokens: t3Code.usage.inputTokens + rawReviewSummary.usage.inputTokens,
    cachedInputTokens: t3Code.usage.cachedInputTokens + rawReviewSummary.usage.cachedInputTokens,
    uncachedInputTokens:
      t3Code.usage.uncachedInputTokens + rawReviewSummary.usage.uncachedInputTokens,
    outputTokens: t3Code.usage.outputTokens + rawReviewSummary.usage.outputTokens,
    estimatedCostUsd: t3Code.usage.estimatedCostUsd + rawReviewSummary.usage.estimatedCostUsd,
  };

  return {
    generatedAt: new Date().toISOString(),
    assumptions: {
      pricingMode: options.forcedModel === undefined ? "recorded-models" : "forced-model",
      ...(options.forcedModel !== undefined ? { forcedModel: options.forcedModel } : {}),
      ...(options.t3PricingModel !== undefined ? { t3PricingModel: options.t3PricingModel } : {}),
      reviewWindow: options.reviewWindow,
    },
    t3Code,
    codexReviews: rawReviewSummary,
    combined,
  };
}

function printHumanReport(report: SpendReport): void {
  console.log(`T3 Code window: ${report.t3Code.window.start} -> ${report.t3Code.window.end}`);
  console.log(
    `T3 Code estimate (${report.assumptions.t3PricingModel ?? report.assumptions.forcedModel ?? "recorded model"} pricing): ${formatUsd(report.t3Code.usage.estimatedCostUsd)}`,
  );
  console.log(
    `  Threads: ${formatInteger(report.t3Code.threads)} | Usage events: ${formatInteger(report.t3Code.usageEvents)}`,
  );
  console.log(
    `  Tokens: input ${formatInteger(report.t3Code.usage.inputTokens)}, cached ${formatInteger(
      report.t3Code.usage.cachedInputTokens,
    )}, output ${formatInteger(report.t3Code.usage.outputTokens)}`,
  );
  console.log(
    `  Earliest thread: ${report.t3Code.earliestThread.title} (${report.t3Code.earliestThread.createdAt})`,
  );
  const t3ModelKeys = Object.keys(report.t3Code.byModel).toSorted();
  for (const model of t3ModelKeys) {
    const entry = report.t3Code.byModel[model];
    if (entry === undefined) {
      continue;
    }
    console.log(
      `  ${model}: ${formatInteger(entry.threads)} threads, ${formatInteger(entry.usageEvents)} events, ${formatUsd(entry.usage.estimatedCostUsd)}`,
    );
  }
  console.log("");
  console.log(
    `Codex review estimate (${report.assumptions.forcedModel ?? (report.codexReviews.windowStrategy === "same-as-t3" ? "same window" : "all time")}): ${formatUsd(report.codexReviews.usage.estimatedCostUsd)}`,
  );
  console.log(
    `  Sessions: ${formatInteger(report.codexReviews.sessions)} | Missing rollouts: ${formatInteger(
      report.codexReviews.skippedMissingRollout,
    )} | No usage rows: ${formatInteger(report.codexReviews.skippedWithoutUsage)}`,
  );
  console.log(
    `  Tokens: input ${formatInteger(report.codexReviews.usage.inputTokens)}, cached ${formatInteger(
      report.codexReviews.usage.cachedInputTokens,
    )}, output ${formatInteger(report.codexReviews.usage.outputTokens)}`,
  );
  const modelKeys = Object.keys(report.codexReviews.byModel).toSorted();
  for (const model of modelKeys) {
    const entry = report.codexReviews.byModel[model];
    if (entry === undefined) {
      continue;
    }
    console.log(
      `  ${model}: ${formatInteger(entry.sessions)} sessions, ${formatUsd(entry.usage.estimatedCostUsd)}`,
    );
  }
  console.log("");
  console.log(`Combined estimate: ${formatUsd(report.combined.estimatedCostUsd)}`);
}

async function main(): Promise<void> {
  const defaults = resolveDefaultPaths();
  const { values } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      "last-days": { type: "string" },
      model: { type: "string" },
      "window-start": { type: "string" },
      "window-end": { type: "string" },
      "review-window": { type: "string", default: "same-as-t3" },
      "t3-pricing-model": { type: "string" },
      "t3-state-db": { type: "string", default: defaults.t3StateDb },
      "codex-state-db": { type: "string", default: defaults.codexStateDb },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const reviewWindow =
    values["review-window"] === "all"
      ? "all"
      : values["review-window"] === "same-as-t3"
        ? "same-as-t3"
        : null;
  if (reviewWindow === null) {
    throw new Error(
      `Invalid --review-window '${values["review-window"]}'. Use 'same-as-t3' or 'all'.`,
    );
  }

  const lastDays = values["last-days"];
  if (
    lastDays !== undefined &&
    (values["window-start"] !== undefined || values["window-end"] !== undefined)
  ) {
    throw new Error("Cannot combine --last-days with --window-start or --window-end.");
  }

  const parsedLastDays =
    lastDays !== undefined
      ? (() => {
          if (!/^\d+$/.test(lastDays)) {
            throw new Error(`Invalid --last-days '${lastDays}'. Use a positive integer.`);
          }
          const numeric = Number(lastDays);
          if (!Number.isSafeInteger(numeric) || numeric <= 0) {
            throw new Error(`Invalid --last-days '${lastDays}'. Use a positive integer.`);
          }
          return numeric;
        })()
      : undefined;

  if (values.model !== undefined && values["t3-pricing-model"] !== undefined) {
    throw new Error("Cannot combine --model with --t3-pricing-model.");
  }

  const report = await createReport({
    t3StateDb: values["t3-state-db"],
    codexStateDb: values["codex-state-db"],
    ...(values.model !== undefined ? { forcedModel: values.model } : {}),
    ...(values["t3-pricing-model"] !== undefined
      ? { t3PricingModel: values["t3-pricing-model"] }
      : {}),
    reviewWindow,
    ...(parsedLastDays !== undefined ? { lastDays: parsedLastDays } : {}),
    ...(values["window-start"] !== undefined ? { windowStart: values["window-start"] } : {}),
    ...(values["window-end"] !== undefined ? { windowEnd: values["window-end"] } : {}),
  });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHumanReport(report);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);

if (isMainModule) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
