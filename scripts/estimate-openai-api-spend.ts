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
    readonly t3PricingModel: string;
    readonly reviewWindow: "same-as-t3" | "all";
  };
  readonly t3Code: T3SpendSummary;
  readonly codexReviews: ReviewSpendSummary;
  readonly combined: UsageCostSummary;
}

export const MODEL_PRICING = {
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
  --window-start <timestamp>     Restrict T3 usage to a start timestamp.
  --window-end <timestamp>       Restrict T3 usage to an end timestamp.
  --review-window <mode>         "same-as-t3" (default) or "all".
  --t3-pricing-model <model>     Pricing model for T3 threads. Default: gpt-5.4
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

function asRows<T>(value: unknown): T {
  return value as T;
}

function loadT3SpendSummary(
  dbPath: string,
  pricing: PricingRates,
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
        a.payload_json AS payloadJson
      FROM projection_thread_activities a
      INNER JOIN projection_threads t ON t.thread_id = a.thread_id
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

    let usage: TokenUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    const threadIds = new Set<string>();
    let earliestThread = {
      id: firstRow.threadId,
      title: firstRow.threadTitle,
      createdAt: firstRow.threadCreatedAt,
    };

    for (const row of rows) {
      usage = addTokenUsage(usage, readT3Payload(row));
      threadIds.add(row.threadId);
      if (row.threadCreatedAt < earliestThread.createdAt) {
        earliestThread = {
          id: row.threadId,
          title: row.threadTitle,
          createdAt: row.threadCreatedAt,
        };
      }
    }

    return {
      threads: threadIds.size,
      usageEvents: rows.length,
      earliestThread,
      window,
      usage: calculateUsageCost(usage, pricing),
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
): Promise<ReviewSpendSummary> {
  const sessions = await loadReviewSessions(dbPath, windowStrategy, window);

  let totalUsage: TokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const byModelUsage = new Map<string, { sessions: number; usage: TokenUsage }>();

  for (const session of sessions) {
    totalUsage = addTokenUsage(totalUsage, session.usage);

    const existing = byModelUsage.get(session.model) ?? {
      sessions: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    };

    byModelUsage.set(session.model, {
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
    usage:
      sessions.length === 0
        ? calculateUsageCost(totalUsage, MODEL_PRICING["gpt-5.4"])
        : {
            inputTokens: totalUsage.inputTokens,
            cachedInputTokens: totalUsage.cachedInputTokens,
            uncachedInputTokens: totalUsage.inputTokens - totalUsage.cachedInputTokens,
            outputTokens: totalUsage.outputTokens,
            estimatedCostUsd: Array.from(byModelUsage.keys()).reduce((sum, model) => {
              const summary = byModelUsage.get(model);
              if (summary === undefined) {
                return sum;
              }
              return (
                sum + calculateUsageCost(summary.usage, resolveKnownPricing(model)).estimatedCostUsd
              );
            }, 0),
          },
    byModel,
  };
}

function calculateReviewCombinedUsage(summary: ReviewSpendSummary): UsageCostSummary {
  let totalUsage: TokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let estimatedCostUsd = 0;

  for (const value of Object.values(summary.byModel)) {
    totalUsage = addTokenUsage(totalUsage, value.usage);
    estimatedCostUsd += value.usage.estimatedCostUsd;
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
  readonly t3PricingModel: string;
  readonly reviewWindow: "same-as-t3" | "all";
  readonly lastDays?: number;
  readonly windowStart?: string;
  readonly windowEnd?: string;
}): Promise<SpendReport> {
  const t3Pricing = resolveKnownPricing(options.t3PricingModel);
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

  const t3Code = loadT3SpendSummary(options.t3StateDb, t3Pricing, explicitWindow);
  const reviewWindow = options.reviewWindow === "same-as-t3" ? t3Code.window : undefined;
  const rawReviewSummary = await loadReviewSpendSummary(
    options.codexStateDb,
    options.reviewWindow,
    reviewWindow,
  );
  const codexReviews = {
    ...rawReviewSummary,
    usage: calculateReviewCombinedUsage(rawReviewSummary),
  };

  const combined = {
    inputTokens: t3Code.usage.inputTokens + codexReviews.usage.inputTokens,
    cachedInputTokens: t3Code.usage.cachedInputTokens + codexReviews.usage.cachedInputTokens,
    uncachedInputTokens: t3Code.usage.uncachedInputTokens + codexReviews.usage.uncachedInputTokens,
    outputTokens: t3Code.usage.outputTokens + codexReviews.usage.outputTokens,
    estimatedCostUsd: t3Code.usage.estimatedCostUsd + codexReviews.usage.estimatedCostUsd,
  };

  return {
    generatedAt: new Date().toISOString(),
    assumptions: {
      t3PricingModel: options.t3PricingModel,
      reviewWindow: options.reviewWindow,
    },
    t3Code,
    codexReviews,
    combined,
  };
}

function printHumanReport(report: SpendReport): void {
  console.log(`T3 Code window: ${report.t3Code.window.start} -> ${report.t3Code.window.end}`);
  console.log(
    `T3 Code estimate (${report.assumptions.t3PricingModel} pricing): ${formatUsd(report.t3Code.usage.estimatedCostUsd)}`,
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
  console.log("");
  console.log(
    `Codex review estimate (${report.codexReviews.windowStrategy === "same-as-t3" ? "same window" : "all time"}): ${formatUsd(report.codexReviews.usage.estimatedCostUsd)}`,
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
      "window-start": { type: "string" },
      "window-end": { type: "string" },
      "review-window": { type: "string", default: "same-as-t3" },
      "t3-pricing-model": { type: "string", default: "gpt-5.4" },
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

  const report = await createReport({
    t3StateDb: values["t3-state-db"],
    codexStateDb: values["codex-state-db"],
    t3PricingModel: values["t3-pricing-model"],
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
