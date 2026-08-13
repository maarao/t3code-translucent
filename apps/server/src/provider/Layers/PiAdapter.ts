import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type PiSettings,
  type ProviderApprovalDecision,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { makePiRpcProcess, type PiRpcProcess, rpcData } from "../pi/PiRpcProcess.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_RESUME_VERSION = 1 as const;
const PI_COMPACTION_TIMEOUT = "2 minutes";
const WORKFLOW_TEXT_MAX_LENGTH = 4_000;
const WORKFLOW_PHASE_MAX_COUNT = 32;
const WORKFLOW_AGENT_MAX_COUNT = 100;
const SETTLED_TASK_MAX_COUNT = 2_048;

interface PiResumeCursor {
  readonly schemaVersion: typeof PI_RESUME_VERSION;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly leafId?: string;
}

interface PendingDialog {
  readonly rpcRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly questionId: string;
  timeoutFiber?: Fiber.Fiber<void, never>;
}

interface PiTurnRecord {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  userEntryId?: string;
}

interface PendingManualCompaction {
  readonly turnId: TurnId;
  readonly completion: Deferred.Deferred<void, never>;
}

interface TaskMetadata {
  readonly title: string;
  readonly role?: string;
  readonly model?: string;
  readonly contextUsage?: { readonly usedTokens?: number; readonly maxTokens: number };
  readonly taskType?: string;
  readonly workflowName?: string;
  readonly agentIndex?: number;
  readonly phaseIndex?: number;
  readonly phaseTitle?: string;
  readonly phases?: ReadonlyArray<{ readonly index: number; readonly title: string }>;
  readonly parentAgentId?: string;
  readonly runHandles?: { readonly runId: string };
  readonly timelineBypass?: boolean;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly process: PiRpcProcess;
  readonly scope: Scope.Closeable;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  exitFiber: Fiber.Fiber<never, never> | undefined;
  session: ProviderSession;
  readonly turns: Array<PiTurnRecord>;
  readonly pendingDialogs: Map<ApprovalRequestId, PendingDialog>;
  readonly runningTaskIds: Set<string>;
  readonly settledTaskIds: Set<string>;
  readonly taskFingerprints: Map<string, string>;
  readonly workflowItemFingerprints: Map<string, string>;
  readonly workflowToolRuns: Map<string, string>;
  readonly taskTurnIds: Map<string, TurnId | undefined>;
  readonly taskMetadata: Map<string, TaskMetadata>;
  readonly taskNamespace: string;
  readonly autoCompactionEnabled: boolean | undefined;
  activeTurnId: TurnId | undefined;
  syntheticTurn: boolean;
  activeTurnCompletion: Deferred.Deferred<void, Error> | undefined;
  manualCompaction: PendingManualCompaction | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  stopped: boolean;
}

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const isUnknownRecord = Schema.is(UnknownRecord);

function record(value: unknown) {
  return isUnknownRecord(value) ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown) {
  const number = numberValue(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

function positiveInteger(value: unknown) {
  const number = nonNegativeInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function taskContextUsage(usedValue: unknown, maxValue: unknown) {
  const maxTokens = positiveInteger(maxValue);
  if (maxTokens === undefined) return undefined;
  const usedTokens = nonNegativeInteger(usedValue);
  return { ...(usedTokens !== undefined ? { usedTokens } : {}), maxTokens };
}

function workflowText(value: unknown) {
  const text = stringValue(value)?.trim();
  return text ? text.slice(0, WORKFLOW_TEXT_MAX_LENGTH) : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseResumeCursor(value: unknown): PiResumeCursor | undefined {
  const cursor = record(value);
  if (
    cursor?.schemaVersion !== PI_RESUME_VERSION ||
    typeof cursor.sessionId !== "string" ||
    cursor.sessionId.length === 0
  ) {
    return undefined;
  }
  return {
    schemaVersion: PI_RESUME_VERSION,
    sessionId: cursor.sessionId,
    ...(typeof cursor.sessionFile === "string" ? { sessionFile: cursor.sessionFile } : {}),
    ...(typeof cursor.leafId === "string" ? { leafId: cursor.leafId } : {}),
  };
}

function modelParts(model: string) {
  const slash = model.indexOf("/");
  return slash > 0
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : undefined;
}

function piRuntimeCommand(value: string | undefined) {
  const input = value?.trim();
  if (input === "/reload") return { type: "reload" } as const;
  if (input === "/compact") {
    return { type: "compact", customInstructions: undefined } as const;
  }
  if (input?.startsWith("/compact ")) {
    const customInstructions = input.slice("/compact ".length).trim();
    return {
      type: "compact",
      ...(customInstructions ? { customInstructions } : {}),
    } as const;
  }
  return undefined;
}

function hasPiCommand(response: Readonly<Record<string, unknown>>, commandName: string) {
  const commands = rpcData(response)?.commands;
  return (
    Array.isArray(commands) &&
    commands.some((value) => {
      const command = record(value);
      return command?.name === commandName && command.source === "extension";
    })
  );
}

function reasoningSelection(options: ReadonlyArray<ProviderOptionSelection> | null | undefined) {
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    const value = record(option);
    if (value?.id === "reasoning" && typeof value.value === "string") return value.value;
  }
  return undefined;
}

function canonicalToolItemType(toolName: string) {
  const name = toolName.toLowerCase();
  if (name.includes("bash") || name.includes("shell") || name.includes("terminal")) {
    return "command_execution" as const;
  }
  if (name === "edit" || name === "write") return "file_change" as const;
  if (name === "read" || name === "grep" || name === "find" || name === "ls") {
    return "dynamic_tool_call" as const;
  }
  if (name.includes("web") || name.includes("search")) return "web_search" as const;
  return "dynamic_tool_call" as const;
}

function messageContentText(message: Readonly<Record<string, unknown>>) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    const value = record(part);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function resultDetails(value: unknown) {
  return record(record(value)?.details);
}

function jsonRecord(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function resultText(value: unknown) {
  const content = record(value)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((entry) => {
    const part = record(entry);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  });
  return text.length > 0 ? text.join("\n").trim() || undefined : undefined;
}

function workflowRunId(value: unknown) {
  return workflowText(resultDetails(value)?.runId)?.slice(0, 256);
}

function workflowPresentation(value: unknown) {
  const details = resultDetails(value);
  if (!details || typeof details.runId !== "string" || !Array.isArray(details.agents)) {
    return {};
  }
  const text = workflowText(resultText(value));
  return {
    ...(text ? { detail: text } : {}),
    data: {
      runId: details.runId,
      ...(workflowText(details.name) ? { name: workflowText(details.name) } : {}),
      ...(workflowText(details.status) ? { status: workflowText(details.status) } : {}),
      ...(workflowText(details.currentPhase)
        ? { currentPhase: workflowText(details.currentPhase) }
        : {}),
      phases: Array.isArray(details.phases)
        ? details.phases.slice(0, WORKFLOW_PHASE_MAX_COUNT).flatMap((rawPhase) => {
            const phase = record(rawPhase);
            const title = workflowText(phase?.title);
            return title ? [{ title }] : [];
          })
        : [],
      agents: details.agents.slice(0, WORKFLOW_AGENT_MAX_COUNT).flatMap((rawAgent) => {
        const agent = record(rawAgent);
        const index = numberValue(agent?.index);
        if (!agent || index === undefined) return [];
        const contextUsage = taskContextUsage(
          record(agent.usage)?.contextTokens,
          agent.contextWindow,
        );
        return [
          {
            index,
            ...(workflowText(agent.label) ? { label: workflowText(agent.label) } : {}),
            ...(workflowText(agent.state) ? { state: workflowText(agent.state) } : {}),
            ...(workflowText(agent.harness) ? { harness: workflowText(agent.harness) } : {}),
            ...(workflowText(agent.model) ? { model: workflowText(agent.model) } : {}),
            ...(contextUsage ? { contextUsage } : {}),
            ...(workflowText(agent.phase) ? { phase: workflowText(agent.phase) } : {}),
            ...(workflowText(agent.preview) ? { preview: workflowText(agent.preview) } : {}),
            ...(workflowText(agent.error) ? { error: workflowText(agent.error) } : {}),
          },
        ];
      }),
    },
  };
}

function workflowFingerprint(value: unknown) {
  const details = resultDetails(value);
  if (!details || !Array.isArray(details.agents)) return workflowText(resultText(value)) ?? "";
  const phases = Array.isArray(details.phases)
    ? details.phases
        .slice(0, WORKFLOW_PHASE_MAX_COUNT)
        .map((rawPhase) => workflowText(record(rawPhase)?.title) ?? "")
    : [];
  const agents = details.agents.slice(0, WORKFLOW_AGENT_MAX_COUNT).flatMap((rawAgent) => {
    const agent = record(rawAgent);
    if (!agent) return [];
    return [
      [
        numberValue(agent.index) ?? "",
        workflowText(agent.label) ?? "",
        workflowText(agent.state) ?? "",
        workflowText(agent.harness) ?? "",
        workflowText(agent.phase) ?? "",
        workflowText(agent.model) ?? "",
        nonNegativeInteger(record(agent.usage)?.contextTokens) ?? "",
        positiveInteger(agent.contextWindow) ?? "",
        workflowText(agent.preview) ?? "",
        workflowText(agent.error) ?? "",
      ].join("\u001e"),
    ];
  });
  return [
    workflowText(resultText(value)) ?? "",
    workflowText(details.name) ?? "",
    workflowText(details.status) ?? "",
    workflowText(details.currentPhase) ?? "",
    ...phases,
    ...agents,
  ].join("\u001f");
}

function subagentStatus(value: unknown) {
  return value === "running" || value === "done" || value === "error" ? value : undefined;
}

function answerText(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return stringArray(value).join(", ");
  return undefined;
}

function dialogQuestion(message: Readonly<Record<string, unknown>>) {
  const method = stringValue(message.method);
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor")
    return undefined;
  const title = stringValue(message.title)?.trim() || "Pi needs input";
  const id = stringValue(message.id);
  if (!id) return undefined;

  if (method === "select") {
    const options = stringArray(message.options).map((label) => ({ label, description: label }));
    return {
      rpcRequestId: id,
      method,
      question: {
        id,
        header: title,
        question: title,
        options,
        multiSelect: false,
      } satisfies UserInputQuestion,
    } as const;
  }

  if (method === "confirm") {
    return {
      rpcRequestId: id,
      method,
      question: {
        id,
        header: title,
        question: stringValue(message.message)?.trim() || title,
        options: [
          { label: "Yes", description: "Confirm" },
          { label: "No", description: "Decline" },
        ],
        multiSelect: false,
      } satisfies UserInputQuestion,
    } as const;
  }

  return {
    rpcRequestId: id,
    method,
    question: {
      id,
      header: title,
      question:
        method === "editor"
          ? "Enter a multiline response"
          : stringValue(message.placeholder)?.trim() || "Enter a response",
      options: [],
      multiSelect: false,
    } satisfies UserInputQuestion,
  } as const;
}

function latestUserEntryId(message: Readonly<Record<string, unknown>>) {
  const data = rpcData(message);
  if (!data || !Array.isArray(data.entries)) return undefined;
  for (let index = data.entries.length - 1; index >= 0; index -= 1) {
    const entry = record(data.entries[index]);
    const entryMessage = record(entry?.message);
    if (
      entry?.type === "message" &&
      entryMessage?.role === "user" &&
      typeof entry.id === "string"
    ) {
      return entry.id;
    }
  }
  return undefined;
}

export function makePiAdapter(
  piSettings: PiSettings,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly instanceId?: ProviderInstanceId;
  } = {},
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const sessions = new Map<ThreadId, PiSessionContext>();
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("pi");
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate a Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = randomUUIDv4.pipe(Effect.map(EventId.make));
    const makeStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(
        Effect.asVoid,
        Effect.catchCause(() => Effect.void),
      );
    const mapRpcError = (threadId: ThreadId, method: string) =>
      Effect.mapError(
        (cause: import("../pi/PiRpcProcess.ts").PiRpcError) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: cause.message,
            cause,
          }),
      );

    const requireSession = (threadId: ThreadId) => {
      const session = sessions.get(threadId);
      return session && !session.stopped
        ? Effect.succeed(session)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const emitTaskCompleted = Effect.fn("PiAdapter.emitTaskCompleted")(function* (
      ctx: PiSessionContext,
      task: {
        readonly id: string;
        readonly title?: string;
        readonly status: "done" | "error" | "stopped";
      },
      summary?: string,
    ) {
      ctx.runningTaskIds.delete(task.id);
      ctx.taskFingerprints.delete(task.id);
      const taskTurnId = ctx.taskTurnIds.get(task.id);
      const metadata = ctx.taskMetadata.get(task.id);
      ctx.taskTurnIds.delete(task.id);
      ctx.taskMetadata.delete(task.id);
      const displayTitle = task.title ?? metadata?.title;
      yield* publish({
        type: "task.completed",
        ...(yield* makeStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        turnId: taskTurnId ?? ctx.activeTurnId,
        payload: {
          taskId: RuntimeTaskId.make(`${ctx.taskNamespace}:${task.id}`),
          status:
            task.status === "error"
              ? "failed"
              : task.status === "stopped"
                ? "stopped"
                : "completed",
          ...(displayTitle ? { title: displayTitle } : {}),
          ...(metadata?.role ? { role: metadata.role } : {}),
          ...(metadata?.model ? { model: metadata.model } : {}),
          ...(metadata?.contextUsage ? { contextUsage: metadata.contextUsage } : {}),
          ...(metadata?.workflowName ? { workflowName: metadata.workflowName } : {}),
          ...(metadata?.agentIndex !== undefined ? { agentIndex: metadata.agentIndex } : {}),
          ...(metadata?.phaseIndex !== undefined ? { phaseIndex: metadata.phaseIndex } : {}),
          ...(metadata?.phaseTitle ? { phaseTitle: metadata.phaseTitle } : {}),
          ...(metadata?.phases ? { phases: metadata.phases } : {}),
          ...(metadata?.parentAgentId ? { parentAgentId: metadata.parentAgentId } : {}),
          ...(metadata?.runHandles ? { runHandles: metadata.runHandles } : {}),
          ...(metadata?.timelineBypass !== undefined
            ? { timelineBypass: metadata.timelineBypass }
            : {}),
          ...(summary?.trim() ? { summary: summary.trim() } : {}),
          taskType: metadata?.taskType ?? "subagent",
          agentKind: "agent",
        },
      });
    });

    const handleSubagentToolResult = Effect.fn("PiAdapter.handleSubagentToolResult")(function* (
      ctx: PiSessionContext,
      toolName: string,
      result: unknown,
    ) {
      const details = resultDetails(result);
      if (!details) return;

      if (toolName === "subagent_spawn") {
        const id = stringValue(details.id);
        if (!id) return;
        const title = stringValue(details.title) ?? id;
        const role = stringValue(details.harness);
        const model = stringValue(details.model);
        const rawContextUsage = record(details.contextUsage);
        const contextUsage = taskContextUsage(
          rawContextUsage?.usedTokens,
          rawContextUsage?.maxTokens,
        );
        ctx.runningTaskIds.add(id);
        ctx.taskTurnIds.set(id, ctx.activeTurnId);
        ctx.taskMetadata.set(id, {
          title,
          ...(role ? { role } : {}),
          ...(model ? { model } : {}),
          ...(contextUsage ? { contextUsage } : {}),
        });
        yield* publish({
          type: "task.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          payload: {
            taskId: RuntimeTaskId.make(`${ctx.taskNamespace}:${id}`),
            description: title,
            title,
            role: role ?? "subagent",
            ...(model ? { model } : {}),
            ...(contextUsage ? { contextUsage } : {}),
            taskType: "subagent",
            agentKind: "agent",
          },
        });
        return;
      }

      const results = Array.isArray(details.results) ? details.results : [];
      for (const rawResult of results) {
        const entry = record(rawResult);
        const id = stringValue(entry?.id);
        const status = subagentStatus(entry?.status);
        if (!id || !status || !ctx.runningTaskIds.has(id)) continue;
        const title = stringValue(entry?.title);
        const metadata = ctx.taskMetadata.get(id);
        const rawContextUsage = record(entry?.contextUsage);
        const contextUsage = taskContextUsage(
          rawContextUsage?.usedTokens,
          rawContextUsage?.maxTokens,
        );
        const nextMetadata = metadata
          ? { ...metadata, ...(contextUsage ? { contextUsage } : {}) }
          : undefined;
        if (nextMetadata) ctx.taskMetadata.set(id, nextMetadata);
        if (status === "running") {
          if (!nextMetadata?.contextUsage) continue;
          const fingerprint = `${nextMetadata.contextUsage.usedTokens ?? ""}/${
            nextMetadata.contextUsage.maxTokens
          }`;
          if (ctx.taskFingerprints.get(id) === fingerprint) continue;
          ctx.taskFingerprints.set(id, fingerprint);
          yield* publish({
            type: "task.progress",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.taskTurnIds.get(id) ?? ctx.activeTurnId,
            payload: {
              taskId: RuntimeTaskId.make(`${ctx.taskNamespace}:${id}`),
              description: title ?? nextMetadata.title,
              status: "running",
              title: title ?? nextMetadata.title,
              ...(nextMetadata.role ? { role: nextMetadata.role } : {}),
              ...(nextMetadata.model ? { model: nextMetadata.model } : {}),
              contextUsage: nextMetadata.contextUsage,
              taskType: "subagent",
              agentKind: "agent",
            },
          });
          continue;
        }
        yield* emitTaskCompleted(ctx, { id, ...(title ? { title } : {}), status });
      }
    });

    const markTaskSettled = (ctx: PiSessionContext, id: string) => {
      ctx.settledTaskIds.add(id);
      if (ctx.settledTaskIds.size <= SETTLED_TASK_MAX_COUNT) return;
      const oldest = ctx.settledTaskIds.values().next().value;
      if (oldest !== undefined) ctx.settledTaskIds.delete(oldest);
    };

    const runningTasksChildrenFirst = (ctx: PiSessionContext) =>
      [...ctx.runningTaskIds].sort((left, right) => {
        const leftIsChild = ctx.taskMetadata.get(left)?.parentAgentId !== undefined;
        const rightIsChild = ctx.taskMetadata.get(right)?.parentAgentId !== undefined;
        return Number(rightIsChild) - Number(leftIsChild);
      });

    const settleWorkflowTasks = Effect.fn("PiAdapter.settleWorkflowTasks")(function* (
      ctx: PiSessionContext,
      runId: string,
      status: "error" | "stopped",
      summary: string,
    ) {
      const coordinatorId = `workflow:${runId}`;
      const childPrefix = `${coordinatorId}:`;
      const childIds = [...ctx.runningTaskIds].filter((id) => id.startsWith(childPrefix));
      for (const id of childIds) {
        yield* emitTaskCompleted(ctx, { id, status }, summary);
        markTaskSettled(ctx, id);
      }
      if (ctx.runningTaskIds.has(coordinatorId)) {
        yield* emitTaskCompleted(ctx, { id: coordinatorId, status }, summary);
        markTaskSettled(ctx, coordinatorId);
      }
    });

    const handleWorkflowResult = Effect.fn("PiAdapter.handleWorkflowResult")(function* (
      ctx: PiSessionContext,
      result: unknown,
    ) {
      const details = resultDetails(result);
      const runId = workflowRunId(result);
      if (!runId || !Array.isArray(details?.agents)) return;
      const workflowName = workflowText(details.name) ?? runId;
      const phases = Array.isArray(details.phases)
        ? details.phases.slice(0, WORKFLOW_PHASE_MAX_COUNT).flatMap((rawPhase, index) => {
            const phase = record(rawPhase);
            const title = workflowText(phase?.title);
            return title ? [{ index, title }] : [];
          })
        : [];

      const coordinatorId = `workflow:${runId}`;
      const coordinatorTaskId = `${ctx.taskNamespace}:${coordinatorId}`;
      const visibleAgents = details.agents.slice(0, WORKFLOW_AGENT_MAX_COUNT);
      const completedAgents = visibleAgents.filter((rawAgent) => {
        const state = workflowText(record(rawAgent)?.state);
        return state === "done" || state === "error";
      }).length;
      const currentPhase = workflowText(details.currentPhase);
      const currentPhaseIndex = currentPhase
        ? phases.find((phase) => phase.title === currentPhase)?.index
        : undefined;
      const coordinatorSummary = `${completedAgents}/${visibleAgents.length} agents${
        currentPhase ? ` · ${currentPhase}` : ""
      }`;
      const coordinatorMetadata: TaskMetadata = {
        title: workflowName,
        role: "workflow",
        taskType: "local_workflow",
        workflowName,
        ...(currentPhaseIndex !== undefined ? { phaseIndex: currentPhaseIndex } : {}),
        ...(currentPhase ? { phaseTitle: currentPhase } : {}),
        ...(phases.length > 0 ? { phases } : {}),
        runHandles: { runId },
      };
      const workflowStatus = workflowText(details.status);
      const workflowIsTerminal =
        workflowStatus === "completed" ||
        workflowStatus === "failed" ||
        workflowStatus === "aborted";
      if (!ctx.settledTaskIds.has(coordinatorId)) {
        ctx.taskMetadata.set(coordinatorId, coordinatorMetadata);
        if (!ctx.runningTaskIds.has(coordinatorId)) {
          ctx.runningTaskIds.add(coordinatorId);
          ctx.taskTurnIds.set(coordinatorId, ctx.activeTurnId);
          ctx.taskMetadata.set(coordinatorId, coordinatorMetadata);
          yield* publish({
            type: "task.started",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: {
              taskId: RuntimeTaskId.make(coordinatorTaskId),
              description: workflowText(details.description) ?? workflowName,
              ...coordinatorMetadata,
              agentKind: "agent",
            },
          });
        }
        if (!workflowIsTerminal && ctx.taskFingerprints.get(coordinatorId) !== coordinatorSummary) {
          ctx.taskFingerprints.set(coordinatorId, coordinatorSummary);
          yield* publish({
            type: "task.progress",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: {
              taskId: RuntimeTaskId.make(coordinatorTaskId),
              description: workflowName,
              summary: coordinatorSummary,
              status: "running",
              ...coordinatorMetadata,
              agentKind: "agent",
            },
          });
        }
      }

      for (const rawAgent of visibleAgents) {
        const agent = record(rawAgent);
        const index = numberValue(agent?.index);
        const state = workflowText(agent?.state);
        if (!agent || index === undefined || !Number.isInteger(index) || index < 0 || !state)
          continue;
        const id = `workflow:${runId}:wf:${index}`;
        if (ctx.settledTaskIds.has(id)) continue;
        const title = workflowText(agent.label) ?? `Agent ${index}`;
        const role = workflowText(agent.harness) ?? "workflow";
        const model = workflowText(agent.model);
        const usage = record(agent.usage);
        const contextUsage = taskContextUsage(usage?.contextTokens, agent.contextWindow);
        const phaseTitle = workflowText(agent.phase);
        const phaseIndex = phaseTitle
          ? phases.find((phase) => phase.title === phaseTitle)?.index
          : undefined;
        const metadata: TaskMetadata = {
          title,
          role,
          ...(model ? { model } : {}),
          ...(contextUsage ? { contextUsage } : {}),
          taskType: "local_agent",
          workflowName,
          agentIndex: index,
          ...(phaseIndex !== undefined ? { phaseIndex } : {}),
          ...(phaseTitle ? { phaseTitle } : {}),
          ...(phases.length > 0 ? { phases } : {}),
          parentAgentId: coordinatorTaskId,
          runHandles: { runId },
          timelineBypass: true,
        };

        if (!ctx.runningTaskIds.has(id)) {
          ctx.runningTaskIds.add(id);
          ctx.taskTurnIds.set(id, ctx.activeTurnId);
          ctx.taskMetadata.set(id, metadata);
          yield* publish({
            type: "task.started",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: {
              taskId: RuntimeTaskId.make(`${ctx.taskNamespace}:${id}`),
              description: title,
              ...metadata,
              agentKind: "agent",
            },
          });
        } else {
          ctx.taskMetadata.set(id, metadata);
        }

        const preview = workflowText(agent.preview);
        if (state === "running") {
          const fingerprint = [
            state,
            title,
            role,
            phaseTitle ?? "",
            model ?? "",
            contextUsage?.usedTokens ?? "",
            contextUsage?.maxTokens ?? "",
            preview ?? "",
          ].join("\u001f");
          if (ctx.taskFingerprints.get(id) === fingerprint) continue;
          ctx.taskFingerprints.set(id, fingerprint);
          yield* publish({
            type: "task.progress",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: {
              taskId: RuntimeTaskId.make(`${ctx.taskNamespace}:${id}`),
              description: title,
              ...(preview ? { summary: preview } : {}),
              status: "running",
              ...metadata,
              agentKind: "agent",
            },
          });
          continue;
        }

        if (state === "done" || state === "error") {
          yield* emitTaskCompleted(ctx, { id, title, status: state }, preview);
          markTaskSettled(ctx, id);
        }
      }

      if (workflowIsTerminal) {
        const unfinishedStatus = workflowStatus === "failed" ? "error" : "stopped";
        const unfinishedSummary = workflowText(details.error) ?? coordinatorSummary;
        const unfinishedChildIds = [...ctx.runningTaskIds].filter((id) =>
          id.startsWith(`${coordinatorId}:`),
        );
        for (const id of unfinishedChildIds) {
          yield* emitTaskCompleted(ctx, { id, status: unfinishedStatus }, unfinishedSummary);
          markTaskSettled(ctx, id);
        }
      }

      if (workflowIsTerminal && !ctx.settledTaskIds.has(coordinatorId)) {
        yield* emitTaskCompleted(
          ctx,
          {
            id: coordinatorId,
            title: workflowName,
            status:
              workflowStatus === "completed"
                ? "done"
                : workflowStatus === "aborted"
                  ? "stopped"
                  : "error",
          },
          workflowText(details.error) ?? coordinatorSummary,
        );
        markTaskSettled(ctx, coordinatorId);
      }
    });

    const emitContextUsage = Effect.fn("PiAdapter.emitContextUsage")(function* (
      ctx: PiSessionContext,
    ) {
      const response = yield* ctx.process.request("get_session_stats").pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(response)) return;
      const data = rpcData(response.value);
      const contextUsage = record(data?.contextUsage);
      const usedTokens =
        contextUsage?.tokens === null ? null : nonNegativeInteger(contextUsage?.tokens);
      if (usedTokens === undefined) return;
      const maxTokens = positiveInteger(contextUsage?.contextWindow);
      const cumulativeTokens = record(data?.tokens);
      const totalProcessedTokens = nonNegativeInteger(cumulativeTokens?.total);
      yield* publish({
        type: "thread.token-usage.updated",
        ...(yield* makeStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        turnId: ctx.activeTurnId,
        payload: {
          usage: {
            usedTokens,
            ...(usedTokens !== null ? { lastUsedTokens: usedTokens } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
            ...(ctx.autoCompactionEnabled !== undefined
              ? { compactsAutomatically: ctx.autoCompactionEnabled }
              : {}),
          },
        },
      });
    });

    const refreshSessionCursor = Effect.fn("PiAdapter.refreshSessionCursor")(function* (
      ctx: PiSessionContext,
      turn?: PiTurnRecord,
    ) {
      const entries = yield* ctx.process
        .request("get_entries")
        .pipe(Effect.orElseSucceed(() => ({})));
      const entryData = rpcData(entries);
      const userEntryId = latestUserEntryId(entries);
      if (turn && userEntryId) turn.userEntryId = userEntryId;
      const stateMessage = yield* ctx.process
        .request("get_state")
        .pipe(mapRpcError(ctx.threadId, "get_state"));
      const state = rpcData(stateMessage);
      const sessionFile = stringValue(state?.sessionFile);
      const leafId = stringValue(entryData?.leafId);
      const cursor: PiResumeCursor = {
        schemaVersion: PI_RESUME_VERSION,
        sessionId:
          stringValue(state?.sessionId) ??
          parseResumeCursor(ctx.session.resumeCursor)?.sessionId ??
          "unknown",
        ...(sessionFile ? { sessionFile } : {}),
        ...(leafId ? { leafId } : {}),
      };
      ctx.session = {
        ...ctx.session,
        status: "ready",
        activeTurnId: undefined,
        resumeCursor: cursor,
        updatedAt: yield* nowIso,
      };
      return cursor;
    });

    const finalizeSettledTurn = Effect.fn("PiAdapter.finalizeSettledTurn")(function* (
      ctx: PiSessionContext,
    ) {
      if (ctx.activeTurnCompletion) {
        yield* Deferred.succeed(ctx.activeTurnCompletion, undefined);
        return;
      }
      if (!ctx.syntheticTurn || !ctx.activeTurnId) return;
      const turnId = ctx.activeTurnId;
      yield* publish({
        type: "turn.completed",
        ...(yield* makeStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        turnId,
        payload: { state: "completed", stopReason: "agent_settled" },
      });
      ctx.syntheticTurn = false;
      ctx.activeTurnId = undefined;
    });

    const handleMessage = Effect.fn("PiAdapter.handleMessage")(function* (
      ctx: PiSessionContext,
      event: Readonly<Record<string, unknown>>,
    ) {
      const type = stringValue(event.type);
      if (!type) return;

      if (type === "agent_start") {
        if (!ctx.activeTurnId) {
          const turnId = TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;
          ctx.syntheticTurn = true;
          yield* publish({
            type: "turn.started",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId,
            payload: { model: ctx.session.model },
          });
        }
        return;
      }
      if (type === "agent_settled") {
        yield* emitContextUsage(ctx);
        yield* finalizeSettledTurn(ctx);
        return;
      }
      if (type === "message_start") {
        const message = record(event.message);
        if (message?.role === "assistant") {
          const timestamp = numberValue(message.timestamp);
          const itemId = RuntimeItemId.make(
            timestamp === undefined
              ? `pi-assistant-${yield* randomUUIDv4}`
              : `pi-assistant-${timestamp}`,
          );
          ctx.activeAssistantItemId = itemId;
          yield* publish({
            type: "item.started",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            itemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
        return;
      }
      if (type === "message_update") {
        const deltaEvent = record(event.assistantMessageEvent);
        const delta = stringValue(deltaEvent?.delta);
        if (!delta) return;
        const deltaType = stringValue(deltaEvent?.type);
        if (deltaType !== "text_delta" && deltaType !== "thinking_delta") return;
        yield* publish({
          type: "content.delta",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          ...(ctx.activeAssistantItemId ? { itemId: ctx.activeAssistantItemId } : {}),
          payload: {
            streamKind: deltaType === "thinking_delta" ? "reasoning_text" : "assistant_text",
            delta,
            ...(numberValue(deltaEvent?.contentIndex) !== undefined
              ? { contentIndex: numberValue(deltaEvent?.contentIndex) }
              : {}),
          },
        });
        return;
      }
      if (type === "message_end") {
        const message = record(event.message);
        if (message?.role === "assistant" && ctx.activeAssistantItemId) {
          yield* publish({
            type: "item.completed",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            itemId: ctx.activeAssistantItemId,
            payload: { itemType: "assistant_message", status: "completed" },
          });
          ctx.activeAssistantItemId = undefined;
          return;
        }
        if (message?.role === "custom" && message.customType === "subagent-result") {
          const details = record(message.details);
          const id = stringValue(details?.id);
          const status = subagentStatus(details?.status);
          if (id && status && status !== "running") {
            const title = stringValue(details?.title);
            const metadata = ctx.taskMetadata.get(id);
            if (metadata) {
              const rawContextUsage = record(details?.contextUsage);
              const contextUsage = taskContextUsage(
                rawContextUsage?.usedTokens,
                rawContextUsage?.maxTokens,
              );
              ctx.taskMetadata.set(id, {
                ...metadata,
                ...(contextUsage ? { contextUsage } : {}),
              });
            }
            yield* emitTaskCompleted(
              ctx,
              { id, ...(title ? { title } : {}), status },
              messageContentText(message),
            );
          }
        }
        return;
      }
      if (type === "tool_execution_start") {
        const toolCallId = stringValue(event.toolCallId);
        const toolName = stringValue(event.toolName) ?? "tool";
        if (!toolCallId || toolName === "subagent_spawn") return;
        yield* publish({
          type: "item.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          itemId: RuntimeItemId.make(toolCallId),
          payload: {
            itemType: canonicalToolItemType(toolName),
            status: "inProgress",
            title: toolName,
          },
        });
        return;
      }
      if (type === "tool_execution_update") {
        const toolCallId = stringValue(event.toolCallId);
        const toolName = stringValue(event.toolName) ?? "tool";
        if (!toolCallId || toolName === "subagent_spawn") return;
        yield* handleSubagentToolResult(ctx, toolName, event.partialResult);
        const presentation =
          toolName === "workflow" ? workflowPresentation(event.partialResult) : {};
        if (toolName === "workflow") {
          const runId = workflowRunId(event.partialResult);
          if (runId) ctx.workflowToolRuns.set(toolCallId, runId);
          yield* handleWorkflowResult(ctx, event.partialResult);
          const fingerprint = workflowFingerprint(event.partialResult);
          if (ctx.workflowItemFingerprints.get(toolCallId) === fingerprint) return;
          ctx.workflowItemFingerprints.set(toolCallId, fingerprint);
        }
        yield* publish({
          type: "item.updated",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          itemId: RuntimeItemId.make(toolCallId),
          payload: {
            itemType: canonicalToolItemType(toolName),
            status: "inProgress",
            title: toolName,
            ...presentation,
          },
        });
        return;
      }
      if (type === "tool_execution_end") {
        const toolCallId = stringValue(event.toolCallId);
        const toolName = stringValue(event.toolName) ?? "tool";
        if (!toolCallId) return;
        yield* handleSubagentToolResult(ctx, toolName, event.result);
        if (toolName === "workflow") {
          const knownRunId = workflowRunId(event.result) ?? ctx.workflowToolRuns.get(toolCallId);
          yield* handleWorkflowResult(ctx, event.result);
          if (event.isError === true && knownRunId) {
            yield* settleWorkflowTasks(
              ctx,
              knownRunId,
              "error",
              resultText(event.result) ?? "Workflow failed.",
            );
          }
          ctx.workflowToolRuns.delete(toolCallId);
          ctx.workflowItemFingerprints.delete(toolCallId);
        }
        if (toolName === "subagent_spawn") return;
        yield* publish({
          type: "item.completed",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          itemId: RuntimeItemId.make(toolCallId),
          payload: {
            itemType: canonicalToolItemType(toolName),
            status: event.isError === true ? "failed" : "completed",
            title: toolName,
            ...(toolName === "workflow" ? workflowPresentation(event.result) : {}),
          },
        });
        return;
      }
      if (type === "extension_ui_request") {
        if (event.method === "setStatus" && event.statusKey === "subagents-runtime") {
          const details = jsonRecord(event.statusText);
          if (details?.version === 1) {
            yield* handleSubagentToolResult(ctx, "subagent_status", { details });
          }
          return;
        }
        const dialog = dialogQuestion(event);
        if (dialog) {
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const pending: PendingDialog = {
            rpcRequestId: dialog.rpcRequestId,
            method: dialog.method,
            questionId: dialog.question.id,
          };
          ctx.pendingDialogs.set(requestId, pending);
          const timeoutMs = numberValue(event.timeout);
          if (timeoutMs !== undefined && timeoutMs > 0) {
            pending.timeoutFiber = yield* Effect.sleep(Duration.millis(timeoutMs)).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  if (ctx.pendingDialogs.get(requestId) !== pending) return;
                  ctx.pendingDialogs.delete(requestId);
                  yield* ctx.process
                    .notify({
                      type: "extension_ui_response",
                      id: dialog.rpcRequestId,
                      cancelled: true,
                    })
                    .pipe(Effect.ignore);
                  yield* publish({
                    type: "user-input.resolved",
                    ...(yield* makeStamp()),
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    requestId: RuntimeRequestId.make(requestId),
                    payload: { answers: {} },
                  });
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logDebug("Pi extension UI timeout cleanup ended.", { cause }),
              ),
              Effect.forkIn(ctx.scope),
            );
          }
          yield* publish({
            type: "user-input.requested",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { questions: [dialog.question] },
            raw: { source: "pi.rpc", method: "extension_ui_request", payload: event },
          });
          return;
        }
        if (event.method === "notify" && event.notifyType !== "info") {
          yield* publish({
            type: "runtime.warning",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: { message: stringValue(event.message) ?? "Pi notification" },
          });
        }
        return;
      }
      if (type === "extension_error") {
        yield* publish({
          type: "runtime.warning",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          payload: {
            message: stringValue(event.error) ?? "A Pi extension failed.",
            detail: event,
          },
        });
        return;
      }
      if (type === "compaction_start") {
        const turnId = ctx.manualCompaction?.turnId ?? ctx.activeTurnId;
        yield* publish({
          type: "item.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(`pi-compaction-${turnId ?? "session"}`),
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Compacting context",
          },
        });
        return;
      }
      if (type === "compaction_end") {
        const pendingManualCompaction = ctx.manualCompaction;
        const turnId = pendingManualCompaction?.turnId ?? ctx.activeTurnId;
        yield* emitContextUsage(ctx);
        yield* publish({
          type: "item.completed",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(`pi-compaction-${turnId ?? "session"}`),
          payload: {
            itemType: "context_compaction",
            status: event.aborted === true || event.errorMessage ? "failed" : "completed",
            title: "Context compaction",
            data: event,
          },
        });
        if (pendingManualCompaction) {
          yield* Deferred.succeed(pendingManualCompaction.completion, undefined);
        }
      }
    });

    const stopSessionInternal = Effect.fn("PiAdapter.stopSessionInternal")(function* (
      ctx: PiSessionContext,
    ) {
      if (ctx.stopped) return;
      ctx.stopped = true;
      if (ctx.eventFiber) yield* Fiber.interrupt(ctx.eventFiber);
      if (ctx.exitFiber) yield* Fiber.interrupt(ctx.exitFiber);
      for (const [requestId, dialog] of ctx.pendingDialogs) {
        if (dialog.timeoutFiber) yield* Fiber.interrupt(dialog.timeoutFiber);
        yield* ctx.process
          .notify({ type: "extension_ui_response", id: dialog.rpcRequestId, cancelled: true })
          .pipe(Effect.ignore);
        ctx.pendingDialogs.delete(requestId);
      }
      if (ctx.activeTurnCompletion) {
        yield* Deferred.fail(ctx.activeTurnCompletion, new Error("Pi session stopped.")).pipe(
          Effect.ignore,
        );
      }
      for (const taskId of runningTasksChildrenFirst(ctx)) {
        yield* emitTaskCompleted(
          ctx,
          { id: taskId, status: "stopped" },
          "Parent Pi session stopped.",
        );
      }
      yield* ctx.process.stop;
      yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      sessions.delete(ctx.threadId);
      yield* publish({
        type: "session.exited",
        ...(yield* makeStamp()),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        payload: { exitKind: "graceful" },
      });
    });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopSessionInternal(existing);

        const cwd = path.resolve(input.cwd.trim());
        const resume = parseResumeCursor(input.resumeCursor);
        const args = [input.runtimeMode === "full-access" ? "--approve" : "--no-approve"];
        if (resume?.sessionFile) args.push("--session", resume.sessionFile);
        const sessionScope = yield* Scope.make("sequential");
        const process = yield* makePiRpcProcess({
          command: piSettings.piBinaryPath || "pi",
          cwd,
          args,
          ...(options.environment ? { env: options.environment } : {}),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        let ctx!: PiSessionContext;

        const selected =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        if (selected) {
          const parts = modelParts(selected.model);
          if (parts) {
            yield* process.request("set_model", parts).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_model",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }
          const reasoning = reasoningSelection(selected.options);
          if (reasoning) {
            yield* process.request("set_thinking_level", { level: reasoning }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_thinking_level",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }
        }

        const stateMessage = yield* process
          .request("get_state")
          .pipe(mapRpcError(input.threadId, "get_state"));
        const state = rpcData(stateMessage);
        const sessionId = stringValue(state?.sessionId) ?? resume?.sessionId;
        if (!sessionId) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: "Pi RPC did not report a session id.",
          });
        }
        const now = yield* nowIso;
        // Pi extension state is process-local: after an RPC process restarts,
        // direct subagent ids begin again at sa-1 even when the durable Pi
        // session resumes. Namespace tasks by this process incarnation so a
        // new child cannot collide with an older persisted Agents-panel row.
        const taskNamespace = `${sessionId}:${yield* randomUUIDv4}`;
        const sessionFile = stringValue(state?.sessionFile);
        const cursor: PiResumeCursor = {
          schemaVersion: PI_RESUME_VERSION,
          sessionId,
          ...(sessionFile ? { sessionFile } : {}),
          ...(resume?.leafId ? { leafId: resume.leafId } : {}),
        };
        const providerSession: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model: selected?.model,
          threadId: input.threadId,
          resumeCursor: cursor,
          createdAt: now,
          updatedAt: now,
        };
        ctx = {
          threadId: input.threadId,
          process,
          scope: sessionScope,
          eventFiber: undefined,
          exitFiber: undefined,
          session: providerSession,
          turns: [],
          pendingDialogs: new Map(),
          runningTaskIds: new Set(),
          settledTaskIds: new Set(),
          taskFingerprints: new Map(),
          workflowItemFingerprints: new Map(),
          workflowToolRuns: new Map(),
          taskTurnIds: new Map(),
          taskMetadata: new Map(),
          taskNamespace,
          autoCompactionEnabled:
            typeof state?.autoCompactionEnabled === "boolean"
              ? state.autoCompactionEnabled
              : undefined,
          activeTurnId: undefined,
          syntheticTurn: false,
          activeTurnCompletion: undefined,
          manualCompaction: undefined,
          activeAssistantItemId: undefined,
          stopped: false,
        };
        ctx.eventFiber = yield* process.events.pipe(
          Stream.runForEach((message) => handleMessage(ctx, message)),
          Effect.catchCause((cause) =>
            Effect.logError("Failed to process Pi RPC event.", { threadId: input.threadId, cause }),
          ),
          Effect.forkIn(sessionScope),
        );
        ctx.exitFiber = yield* process.exit.pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              if (ctx.stopped) return yield* Effect.never;
              if (ctx.activeTurnCompletion) {
                yield* Deferred.fail(ctx.activeTurnCompletion, cause).pipe(Effect.ignore);
              }
              for (const taskId of runningTasksChildrenFirst(ctx)) {
                yield* emitTaskCompleted(
                  ctx,
                  { id: taskId, status: "error" },
                  "Parent Pi process exited.",
                );
              }
              yield* publish({
                type: "runtime.error",
                ...(yield* makeStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                turnId: ctx.activeTurnId,
                payload: { message: cause.message, class: "transport_error" },
              });
              return yield* Effect.never;
            }),
          ),
          Effect.catchCause(() => Effect.never),
          Effect.forkIn(sessionScope),
        );
        sessions.set(input.threadId, ctx);

        yield* publish({
          type: "session.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { resume: cursor },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Pi RPC session ready" },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { providerThreadId: sessionId },
        });
        yield* emitContextUsage(ctx);
        return providerSession;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const runtimeCommand = piRuntimeCommand(input.input);
        if (runtimeCommand && (input.attachments?.length ?? 0) > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Pi /${runtimeCommand.type} does not accept attachments.`,
          });
        }
        if (runtimeCommand && ctx.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Wait for the active Pi turn to finish before running /${runtimeCommand.type}.`,
          });
        }
        if (runtimeCommand) {
          const turnId = TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;
          ctx.syntheticTurn = false;
          ctx.turns.push({ id: turnId, items: [] });
          yield* publish({
            type: "turn.started",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: { model: ctx.session.model },
          });

          const executeCommand = Effect.gen(function* () {
            if (runtimeCommand.type === "compact") {
              const completion = yield* Deferred.make<void, never>();
              ctx.manualCompaction = { turnId, completion };
              yield* ctx.process
                .request(
                  "compact",
                  runtimeCommand.customInstructions
                    ? { customInstructions: runtimeCommand.customInstructions }
                    : undefined,
                  { timeout: PI_COMPACTION_TIMEOUT },
                )
                .pipe(mapRpcError(input.threadId, "compact"));
              yield* Deferred.await(completion).pipe(Effect.timeoutOption("5 seconds"));
              return;
            }

            const commands = yield* ctx.process
              .request("get_commands")
              .pipe(mapRpcError(input.threadId, "get_commands"));
            if (!hasPiCommand(commands, "reload")) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "reload",
                detail:
                  "Pi did not report a /reload extension command. Install the reload bridge extension and restart the Pi session.",
              });
            }
            yield* ctx.process
              .request("prompt", { message: "/reload" })
              .pipe(mapRpcError(input.threadId, "reload"));
          });

          yield* executeCommand.pipe(
            Effect.tapError((cause) =>
              Effect.gen(function* () {
                ctx.activeTurnId = undefined;
                ctx.manualCompaction = undefined;
                yield* publish({
                  type: "turn.completed",
                  ...(yield* makeStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    stopReason: "command_failed",
                    errorMessage: cause.message,
                  },
                });
              }),
            ),
          );
          ctx.manualCompaction = undefined;
          yield* emitContextUsage(ctx);
          yield* publish({
            type: "turn.completed",
            ...(yield* makeStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: { state: "completed", stopReason: "command_completed" },
          });
          ctx.activeTurnId = undefined;
          const cursor = yield* refreshSessionCursor(ctx);
          return { threadId: input.threadId, turnId, resumeCursor: cursor };
        }
        if (ctx.activeTurnCompletion) {
          const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              };
            }),
          );
          const completion = ctx.activeTurnCompletion;
          yield* ctx.process
            .request("prompt", {
              message: input.input ?? "",
              images,
              streamingBehavior: "steer",
            })
            .pipe(mapRpcError(input.threadId, "prompt"));
          yield* Deferred.await(completion).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          return {
            threadId: input.threadId,
            turnId: ctx.activeTurnId!,
            resumeCursor: ctx.session.resumeCursor,
          };
        }

        const turnId = TurnId.make(yield* randomUUIDv4);
        const completion = yield* Deferred.make<void, Error>();
        ctx.activeTurnId = turnId;
        ctx.syntheticTurn = false;
        ctx.activeTurnCompletion = completion;
        const turn: PiTurnRecord = { id: turnId, items: [] };
        ctx.turns.push(turn);
        yield* publish({
          type: "turn.started",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: { model: input.modelSelection?.model ?? ctx.session.model },
        });

        const selected =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        if (selected && selected.model !== ctx.session.model) {
          const parts = modelParts(selected.model);
          if (parts) {
            yield* ctx.process
              .request("set_model", parts)
              .pipe(mapRpcError(input.threadId, "set_model"));
          }
          const reasoning = reasoningSelection(selected.options);
          if (reasoning) {
            yield* ctx.process
              .request("set_thinking_level", { level: reasoning })
              .pipe(mapRpcError(input.threadId, "set_thinking_level"));
          }
          ctx.session = { ...ctx.session, model: selected.model };
        }

        const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            return {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            };
          }),
        );

        yield* ctx.process.request("prompt", { message: input.input ?? "", images }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: cause.message,
                cause,
              }),
          ),
        );
        yield* Deferred.await(completion).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        ctx.activeTurnCompletion = undefined;
        ctx.activeTurnId = undefined;
        yield* publish({
          type: "turn.completed",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: { state: "completed", stopReason: "agent_settled" },
        });

        const cursor = yield* refreshSessionCursor(ctx, turn);
        return { threadId: input.threadId, turnId, resumeCursor: cursor };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* ctx.process.request("abort").pipe(Effect.ignore);
        for (const [requestId, dialog] of ctx.pendingDialogs) {
          if (dialog.timeoutFiber) yield* Fiber.interrupt(dialog.timeoutFiber);
          yield* ctx.process
            .notify({ type: "extension_ui_response", id: dialog.rpcRequestId, cancelled: true })
            .pipe(Effect.ignore);
          ctx.pendingDialogs.delete(requestId);
        }
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      _decision: ProviderApprovalDecision,
    ) =>
      requireSession(threadId).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToRequest",
              detail: `Pi has no pending approval request '${requestId}'.`,
            }),
          ),
        ),
      );

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const dialog = ctx.pendingDialogs.get(requestId);
        if (!dialog) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending Pi input request '${requestId}'.`,
          });
        }
        const answer = answerText(answers[dialog.questionId]);
        const response =
          dialog.method === "confirm"
            ? {
                type: "extension_ui_response",
                id: dialog.rpcRequestId,
                confirmed: answer === "Yes",
              }
            : answer
              ? { type: "extension_ui_response", id: dialog.rpcRequestId, value: answer }
              : { type: "extension_ui_response", id: dialog.rpcRequestId, cancelled: true };
        if (dialog.timeoutFiber) yield* Fiber.interrupt(dialog.timeoutFiber);
        yield* ctx.process.notify(response).pipe(mapRpcError(threadId, "extension_ui_response"));
        ctx.pendingDialogs.delete(requestId);
        yield* publish({
          type: "user-input.resolved",
          ...(yield* makeStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          turnId: ctx.activeTurnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        const firstRemoved = ctx.turns[nextLength];
        if (nextLength === 0) {
          yield* ctx.process.request("new_session").pipe(mapRpcError(threadId, "new_session"));
        } else if (firstRemoved?.userEntryId) {
          yield* ctx.process
            .request("fork", { entryId: firstRemoved.userEntryId })
            .pipe(mapRpcError(threadId, "fork"));
        } else {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "fork",
            detail: "Pi does not have a durable entry cursor for the requested rollback point.",
          });
        }
        ctx.turns.splice(nextLength);
        const stateMessage = yield* ctx.process
          .request("get_state")
          .pipe(mapRpcError(threadId, "get_state"));
        const state = rpcData(stateMessage);
        const entryMessage = yield* ctx.process
          .request("get_entries")
          .pipe(mapRpcError(threadId, "get_entries"));
        const entryData = rpcData(entryMessage);
        const sessionId = stringValue(state?.sessionId);
        if (sessionId) {
          const sessionFile = stringValue(state?.sessionFile);
          const leafId = stringValue(entryData?.leafId);
          ctx.session = {
            ...ctx.session,
            resumeCursor: {
              schemaVersion: PI_RESUME_VERSION,
              sessionId,
              ...(sessionFile ? { sessionFile } : {}),
              ...(leafId ? { leafId } : {}),
            } satisfies PiResumeCursor,
          };
        }
        return { threadId, turns: ctx.turns };
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.flatMap(requireSession(threadId), stopSessionInternal);
    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ctx.session));
    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });
    const stopAll = () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEvents)),
        Effect.catchCause((cause) => Effect.logError("Failed to stop Pi RPC sessions.", { cause })),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
