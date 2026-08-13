import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonRecord = Schema.decodeUnknownExit(Schema.fromJsonString(JsonRecord));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(JsonRecord));
const isJsonRecord = Schema.is(JsonRecord);
const textEncoder = new TextEncoder();

export class PiRpcError extends Schema.TaggedErrorClass<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

const isPiRpcError = Schema.is(PiRpcError);

export interface PiRpcProcessOptions {
  readonly command: string;
  readonly cwd: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeout?: "30 seconds" | "60 seconds";
}

export interface PiRpcProcess {
  readonly request: (
    type: string,
    payload?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, PiRpcError>;
  readonly notify: (message: Readonly<Record<string, unknown>>) => Effect.Effect<void, PiRpcError>;
  readonly events: Stream.Stream<Readonly<Record<string, unknown>>>;
  readonly exit: Effect.Effect<never, PiRpcError>;
  readonly stop: Effect.Effect<void>;
  readonly getStderr: Effect.Effect<string>;
}

interface PendingRequest {
  readonly command: string;
  readonly response: Deferred.Deferred<Readonly<Record<string, unknown>>, PiRpcError>;
}

function rpcError(operation: string, cause: unknown, detail?: string) {
  return new PiRpcError({
    operation,
    detail: detail ?? (cause instanceof Error ? cause.message : String(cause)),
    cause,
  });
}

export const makePiRpcProcess = Effect.fn("makePiRpcProcess")(function* (
  options: PiRpcProcessOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const eventQueue = yield* Queue.unbounded<Readonly<Record<string, unknown>>>();
  const stderrRef = yield* Ref.make("");
  const pendingRef = yield* Ref.make(new Map<string, PendingRequest>());
  const sequenceRef = yield* Ref.make(0);
  const writeSemaphore = yield* Semaphore.make(1);
  const exitSignal = yield* Deferred.make<never, PiRpcError>();

  const spawnCommand = yield* resolveSpawnCommand(
    options.command,
    ["--mode", "rpc", ...(options.args ?? [])],
    options.env ? { env: options.env, extendEnv: true } : {},
  ).pipe(Effect.mapError((cause) => rpcError("spawn", cause)));

  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        ...(options.env ? { env: options.env, extendEnv: true } : {}),
        shell: spawnCommand.shell,
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError((cause) => rpcError("spawn", cause)),
    );

  const failPending = Effect.fn("PiRpcProcess.failPending")(function* (cause: PiRpcError) {
    const pending = yield* Ref.getAndSet(pendingRef, new Map());
    yield* Effect.forEach(pending.values(), (request) =>
      Deferred.fail(request.response, cause).pipe(Effect.ignore),
    );
  });

  const handleLine = Effect.fn("PiRpcProcess.handleLine")(function* (line: string) {
    if (!line.trim()) return;
    const decoded = decodeJsonRecord(line);
    if (Exit.isFailure(decoded)) {
      return yield* rpcError("decode", line, "Pi emitted malformed JSONL output.");
    }
    const message = decoded.value;
    const id = typeof message.id === "string" ? message.id : undefined;
    if (message.type === "response" && id) {
      const pending = yield* Ref.modify(pendingRef, (current) => {
        const request = current.get(id);
        if (!request) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(id);
        return [request, next] as const;
      });
      if (pending) {
        yield* Deferred.succeed(pending.response, message);
        return;
      }
    }
    yield* Queue.offer(eventQueue, message);
  });

  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(handleLine),
    Effect.catch((cause) => {
      const error = isPiRpcError(cause) ? cause : rpcError("stdout", cause);
      return failPending(error).pipe(
        Effect.andThen(Deferred.fail(exitSignal, error)),
        Effect.ignore,
      );
    }),
    Effect.forkIn(scope),
  );

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrRef, (current) => `${current}${chunk}`.slice(-16_000)),
    ),
    Effect.catchCause((cause) => Effect.logDebug("Pi RPC stderr stream ended.", { cause })),
    Effect.forkIn(scope),
  );

  yield* child.exitCode.pipe(
    Effect.flatMap((code) =>
      Ref.get(stderrRef).pipe(
        Effect.flatMap((stderr) => {
          const cause = rpcError(
            "process",
            code,
            `${options.command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-4_000)}` : ""}`,
          );
          return failPending(cause).pipe(Effect.andThen(Deferred.fail(exitSignal, cause)));
        }),
      ),
    ),
    Effect.catchCause((cause) => Effect.logDebug("Pi RPC exit watcher ended.", { cause })),
    Effect.forkIn(scope),
  );

  const write = Effect.fn("PiRpcProcess.write")(function* (
    operation: string,
    message: Readonly<Record<string, unknown>>,
  ) {
    const line = yield* encodeJson(message).pipe(
      Effect.mapError((cause) => rpcError(operation, cause, "Failed to encode Pi RPC message.")),
    );
    yield* Stream.make(textEncoder.encode(`${line}\n`)).pipe(
      Stream.run(child.stdin),
      Effect.mapError((cause) => rpcError(operation, cause)),
      writeSemaphore.withPermit,
    );
  });

  const request: PiRpcProcess["request"] = (type, payload = {}) =>
    Effect.gen(function* () {
      const sequence = yield* Ref.getAndUpdate(sequenceRef, (current) => current + 1);
      const id = `t3-${sequence + 1}`;
      const response = yield* Deferred.make<Readonly<Record<string, unknown>>, PiRpcError>();
      yield* Ref.update(pendingRef, (current) => {
        const next = new Map(current);
        next.set(id, { command: type, response });
        return next;
      });
      yield* write(type, { ...payload, id, type }).pipe(
        Effect.onError(() =>
          Ref.update(pendingRef, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
      const message = yield* Deferred.await(response).pipe(
        Effect.timeoutOrElse({
          duration: options.requestTimeout ?? "30 seconds",
          orElse: () =>
            Effect.fail(
              new PiRpcError({
                operation: type,
                detail: "Timed out waiting for a response.",
              }),
            ),
        }),
        Effect.ensuring(
          Ref.update(pendingRef, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
      if (message.success === false) {
        return yield* new PiRpcError({
          operation: type,
          detail: typeof message.error === "string" ? message.error : "Pi rejected the request.",
        });
      }
      return message;
    });

  const notify: PiRpcProcess["notify"] = (message) => write("notify", message);
  const stop = child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);

  const service: PiRpcProcess = {
    request,
    notify,
    events: Stream.fromQueue(eventQueue),
    exit: Deferred.await(exitSignal),
    stop,
    getStderr: Ref.get(stderrRef),
  };

  yield* request("get_state");
  return service;
});

export function rpcData(message: Readonly<Record<string, unknown>>) {
  return isJsonRecord(message.data) ? message.data : undefined;
}
