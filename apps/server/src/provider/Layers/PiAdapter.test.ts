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
      assert.equal(taskStarted.payload.taskId, "mock-pi-session:sa-1");
      assert(
        events.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
      );
      const taskCompleted = events.find((event) => event.type === "task.completed");
      assert(taskCompleted?.type === "task.completed");
      assert.equal(taskCompleted.payload.taskId, taskStarted.payload.taskId);
      assert.equal(taskCompleted.payload.status, "completed");
      assert.equal(events.filter((event) => event.type === "turn.started").length, 2);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 2);
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
