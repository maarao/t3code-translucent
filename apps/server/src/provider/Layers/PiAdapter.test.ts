// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-rpc-mock-agent.ts");

async function makeMockPiWrapper(extraEnv: Readonly<Record<string, string>> = {}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-rpc-mock-"));
  const wrapperPath = NodePath.join(dir, "pi");
  const exports = Object.entries(extraEnv)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\n${exports}\nexec node ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("PiAdapter", (it) => {
  it.effect("maps direct Pi RPC assistant, reasoning, and subagent lifecycle events", () =>
    Effect.gen(function* () {
      const wrapper = yield* Effect.promise(() =>
        makeMockPiWrapper({
          T3_PI_RPC_EMIT_SUBAGENT: "1",
          T3_PI_RPC_EMIT_SUBAGENT_RESULT: "1",
        }),
      );
      const adapter = yield* makePiAdapter(decodePiSettings({ piBinaryPath: wrapper }), {
        instanceId: ProviderInstanceId.make("pi"),
      });
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      const threadId = ThreadId.make("pi-rpc-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 30)));
      yield* Fiber.interrupt(eventFiber);

      assert(
        events.some(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        ),
      );
      assert(
        events.some(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
        ),
      );
      const taskStarted = events.find((event) => event.type === "task.started");
      assert(taskStarted?.type === "task.started");
      assert.equal(taskStarted.payload.title, "reviewer");
      assert.equal(taskStarted.payload.role, "codex");
      assert.match(taskStarted.payload.taskId, /^mock-pi-session:[^:]+:sa-1$/);
      assert.deepEqual(taskStarted.payload.contextUsage, {
        usedTokens: 0,
        maxTokens: 100_000,
      });
      const taskProgress = events.filter(
        (event) =>
          event.type === "task.progress" && event.payload.taskId === taskStarted.payload.taskId,
      );
      assert.equal(taskProgress.length, 2);
      assert(taskProgress[0]?.type === "task.progress");
      assert.deepEqual(taskProgress[0].payload.contextUsage, {
        usedTokens: 8_000,
        maxTokens: 100_000,
      });
      assert(taskProgress[1]?.type === "task.progress");
      assert.deepEqual(taskProgress[1].payload.contextUsage, {
        usedTokens: 16_000,
        maxTokens: 100_000,
      });
      assert(
        events.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
      );
      const taskCompleted = events.find((event) => event.type === "task.completed");
      assert(taskCompleted?.type === "task.completed");
      assert.equal(taskCompleted.payload.taskId, taskStarted.payload.taskId);
      assert.equal(taskCompleted.payload.status, "completed");
      assert.deepEqual(taskCompleted.payload.contextUsage, {
        usedTokens: 32_000,
        maxTokens: 100_000,
      });
      assert.equal(events.filter((event) => event.type === "turn.started").length, 2);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 2);
      const contextUsage = events.findLast((event) => event.type === "thread.token-usage.updated");
      assert(contextUsage?.type === "thread.token-usage.updated");
      assert.deepEqual(contextUsage.payload.usage, {
        usedTokens: 24_000,
        lastUsedTokens: 24_000,
        maxTokens: 100_000,
        totalProcessedTokens: 10_000,
        compactsAutomatically: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("namespaces reused extension subagent ids per Pi process", () =>
    Effect.gen(function* () {
      const wrapper = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_RPC_EMIT_SUBAGENT: "1" }),
      );
      const firstAdapter = yield* makePiAdapter(decodePiSettings({ piBinaryPath: wrapper }));
      const secondAdapter = yield* makePiAdapter(decodePiSettings({ piBinaryPath: wrapper }));
      const firstEvents: Array<ProviderRuntimeEvent> = [];
      const secondEvents: Array<ProviderRuntimeEvent> = [];
      const firstFiber = yield* firstAdapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => firstEvents.push(event))),
        Effect.forkChild,
      );
      const secondFiber = yield* secondAdapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => secondEvents.push(event))),
        Effect.forkChild,
      );
      const threadId = ThreadId.make("pi-rpc-restarted-thread");
      const startInput = {
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access" as const,
      };
      yield* firstAdapter.startSession(startInput);
      yield* secondAdapter.startSession(startInput);
      yield* firstAdapter.sendTurn({ threadId, input: "first process" });
      yield* secondAdapter.sendTurn({ threadId, input: "second process" });
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 30)));
      yield* Fiber.interrupt(firstFiber);
      yield* Fiber.interrupt(secondFiber);

      const firstStarted = firstEvents.find((event) => event.type === "task.started");
      const secondStarted = secondEvents.find((event) => event.type === "task.started");
      assert(firstStarted?.type === "task.started");
      assert(secondStarted?.type === "task.started");
      assert.match(firstStarted.payload.taskId, /^mock-pi-session:[^:]+:sa-1$/);
      assert.match(secondStarted.payload.taskId, /^mock-pi-session:[^:]+:sa-1$/);
      assert.notEqual(firstStarted.payload.taskId, secondStarted.payload.taskId);
    }).pipe(Effect.scoped),
  );

  it.effect("maps workflow progress and child agents into T3 runtime events", () =>
    Effect.gen(function* () {
      const wrapper = yield* Effect.promise(() =>
        makeMockPiWrapper({ T3_PI_RPC_EMIT_WORKFLOW: "1" }),
      );
      const adapter = yield* makePiAdapter(decodePiSettings({ piBinaryPath: wrapper }));
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      const threadId = ThreadId.make("pi-rpc-workflow-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run workflow" });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(eventFiber);

      const workflowItems = events.filter(
        (event) => event.type === "item.updated" && event.itemId === "workflow-tool",
      );
      assert.equal(workflowItems.length, 1);
      const workflowItem = workflowItems[0];
      assert(workflowItem?.type === "item.updated");
      assert.equal(workflowItem.payload.detail, "workflow Mock workflow: 0/1 agents · Review");
      assert(
        typeof workflowItem.payload.data === "object" &&
          workflowItem.payload.data !== null &&
          "runId" in workflowItem.payload.data,
      );
      assert.equal(workflowItem.payload.data.runId, "wf-mock");

      const taskStarts = events.filter((event) => event.type === "task.started");
      assert.equal(taskStarts.length, 2);
      const coordinator = taskStarts.find((event) =>
        event.payload.taskId.endsWith(":workflow:wf-mock"),
      );
      assert(coordinator?.type === "task.started");
      assert.equal(coordinator.payload.taskType, "local_workflow");
      assert.equal(coordinator.payload.workflowName, "Mock workflow");
      assert.equal(coordinator.payload.runHandles?.runId, "wf-mock");
      assert.equal(coordinator.payload.phaseTitle, "Review");
      assert.equal(coordinator.payload.phaseIndex, 0);

      const child = taskStarts.find((event) =>
        event.payload.taskId.endsWith(":workflow:wf-mock:wf:1"),
      );
      assert(child?.type === "task.started");
      assert.equal(child.payload.role, "codex");
      assert.equal(child.payload.model, "gpt-test");
      assert.equal(child.payload.taskType, "local_agent");
      assert.equal(child.payload.phaseTitle, "Review");
      assert.equal(child.payload.phaseIndex, 0);
      assert.equal(child.payload.parentAgentId, coordinator.payload.taskId);
      assert.equal(child.payload.timelineBypass, true);
      assert.deepEqual(child.payload.contextUsage, {
        usedTokens: 24_000,
        maxTokens: 100_000,
      });

      const taskProgress = events.filter((event) => event.type === "task.progress");
      assert.equal(taskProgress.length, 2);
      const childProgress = taskProgress.find(
        (event) => event.payload.taskId === child.payload.taskId,
      );
      assert(childProgress?.type === "task.progress");
      assert.equal(childProgress.payload.summary, "Inspecting adapter");
      assert.deepEqual(childProgress.payload.contextUsage, {
        usedTokens: 24_000,
        maxTokens: 100_000,
      });

      const completions = events.filter((event) => event.type === "task.completed");
      assert.equal(completions.length, 2);
      const coordinatorCompletion = completions.find(
        (event) => event.payload.taskId === coordinator.payload.taskId,
      );
      assert(coordinatorCompletion?.type === "task.completed");
      assert.equal(coordinatorCompletion.payload.status, "completed");
      assert.equal(coordinatorCompletion.payload.phaseTitle, "Report");
      assert.equal(coordinatorCompletion.payload.phaseIndex, 1);
      const childCompletion = completions.find(
        (event) => event.payload.taskId === child.payload.taskId,
      );
      assert(childCompletion?.type === "task.completed");
      assert.deepEqual(childCompletion.payload.contextUsage, {
        usedTokens: 28_000,
        maxTokens: 100_000,
      });
      assert(
        completions.some(
          (event) =>
            event.payload.taskId === child.payload.taskId &&
            event.payload.summary === "Review complete",
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("settles workflow tasks when the workflow tool fails without details", () =>
    Effect.gen(function* () {
      const wrapper = yield* Effect.promise(() =>
        makeMockPiWrapper({
          T3_PI_RPC_EMIT_WORKFLOW: "1",
          T3_PI_RPC_WORKFLOW_ERROR: "1",
        }),
      );
      const adapter = yield* makePiAdapter(decodePiSettings({ piBinaryPath: wrapper }));
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      const threadId = ThreadId.make("pi-rpc-failed-workflow-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run failing workflow" });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(eventFiber);

      const completions = events.filter((event) => event.type === "task.completed");
      assert.equal(completions.length, 2);
      assert(
        completions.every(
          (event) =>
            event.payload.status === "failed" && event.payload.summary === "Workflow crashed",
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("bridges free-text extension UI through T3 user input", () =>
    Effect.gen(function* () {
      const requestLog = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-ui-"))),
        "requests.ndjson",
      );
      const wrapper = yield* Effect.promise(() =>
        makeMockPiWrapper({
          T3_PI_RPC_EMIT_INPUT: "1",
          T3_PI_RPC_REQUEST_LOG_PATH: requestLog,
        }),
      );
      const adapter = yield* makePiAdapter(decodePiSettings({ piBinaryPath: wrapper }));
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      const threadId = ThreadId.make("pi-rpc-input-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "ask me" });
      yield* Effect.yieldNow;
      const requested = events.find((event) => event.type === "user-input.requested");
      assert(requested?.type === "user-input.requested");
      assert.deepEqual(requested.payload.questions[0]?.options, []);
      const requestId = requested.requestId;
      assert(requestId);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(requestId), {
        "ui-1": "typed answer",
      });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(eventFiber);
      const log = yield* Effect.promise(() => NodeFSP.readFile(requestLog, "utf8"));
      assert.match(log, /"type":"extension_ui_response"/u);
      assert.match(log, /"value":"typed answer"/u);
    }).pipe(Effect.scoped),
  );
});
