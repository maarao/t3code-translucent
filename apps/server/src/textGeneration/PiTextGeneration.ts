import { TextGenerationError, type ModelSelection, type PiSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makePiRpcProcess } from "../provider/pi/PiRpcProcess.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const isUnknownRecord = Schema.is(UnknownRecord);
const isTextGenerationError = Schema.is(TextGenerationError);

function record(value: unknown) {
  return isUnknownRecord(value) ? value : undefined;
}

function modelParts(model: string) {
  const slash = model.indexOf("/");
  return slash > 0
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : undefined;
}

function reasoningSelection(modelSelection: ModelSelection) {
  const option = modelSelection.options?.find((candidate) => candidate.id === "reasoning");
  return typeof option?.value === "string" ? option.value : undefined;
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const outputRef = yield* Ref.make("");
      const settled = yield* Deferred.make<void>();
      const runtime = yield* makePiRpcProcess({
        command: piSettings.piBinaryPath || "pi",
        cwd: input.cwd,
        args: ["--no-session", "--approve"],
        ...(environment ? { env: environment } : {}),
        requestTimeout: "60 seconds",
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: cause.message,
              cause,
            }),
        ),
      );

      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (event.type === "agent_settled") return Deferred.succeed(settled, undefined);
          if (event.type !== "message_update") return Effect.void;
          const deltaEvent = record(event.assistantMessageEvent);
          return deltaEvent?.type === "text_delta" && typeof deltaEvent.delta === "string"
            ? Ref.update(outputRef, (current) => current + deltaEvent.delta)
            : Effect.void;
        }),
        Effect.catchCause((cause) =>
          Effect.logDebug("Pi text-generation event stream ended.", { cause }),
        ),
        Effect.forkIn(scope),
      );

      const parts = modelParts(input.modelSelection.model);
      if (parts) {
        yield* runtime.request("set_model", parts).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: cause.message,
                cause,
              }),
          ),
        );
      }
      const reasoning = reasoningSelection(input.modelSelection);
      if (reasoning) {
        yield* runtime.request("set_thinking_level", { level: reasoning }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: cause.message,
                cause,
              }),
          ),
        );
      }
      yield* runtime.request("prompt", { message: input.prompt }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: cause.message,
              cause,
            }),
        ),
      );
      yield* Deferred.await(settled).pipe(
        Effect.timeoutOrElse({
          duration: "3 minutes",
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi text generation timed out.",
              }),
            ),
        }),
      );
      const rawResult = (yield* Ref.get(outputRef)).trim();
      yield* runtime.stop;
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Pi returned empty output.",
        });
      }
      // Dynamic per operation: each prompt supplies its own output schema.
      // oxlint-disable-next-line t3code/no-inline-schema-compile
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Pi returned invalid structured output.",
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Pi text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
