import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelCapabilities,
  type PiSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;
const PROBE_TIMEOUT_MS = 15_000;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const REASONING_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function titleCase(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function capabilitiesForModel(supportsThinking: boolean): ModelCapabilities {
  if (!supportsThinking) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoning",
        label: "Thinking",
        type: "select",
        options: REASONING_OPTIONS.map((level) => ({
          id: level,
          label: titleCase(level),
          ...(level === "high" ? { isDefault: true as const } : {}),
        })),
        currentValue: "high",
      },
    ],
  });
}

/** Parse the stable tabular output produced by `pi --list-models`. */
export function parsePiModelList(output: string): ReadonlyArray<ServerProviderModel> {
  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[PI_DRIVER];
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];

  for (const rawLine of output.split(/\r?\n/u).slice(1)) {
    const columns = rawLine.trim().split(/\s+/u);
    if (columns.length < 6) continue;
    const [provider, model, , , thinking] = columns;
    if (!provider || !model || (thinking !== "yes" && thinking !== "no")) continue;
    const slug = `${provider}/${model}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: model,
      subProvider: provider,
      isCustom: false,
      ...(slug === defaultModel ? { isDefault: true } : {}),
      capabilities: capabilitiesForModel(thinking === "yes"),
    });
  }

  return models;
}

const runPiCommand = (
  piSettings: PiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = piSettings.piBinaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

function modelsFromSettings(
  piSettings: PiSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discovered, piSettings.customModels, EMPTY_CAPABILITIES);
}

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: modelsFromSettings(piSettings),
      probe: piSettings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
    });
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(piSettings);

  if (!piSettings.enabled) {
    return yield* buildInitialPiProviderSnapshot(piSettings);
  }

  const adapterPath = piSettings.binaryPath || "pi-acp";
  const adapterAvailable = yield* resolveCommandPath(adapterPath, { env: environment }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!adapterAvailable) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The Pi ACP adapter (`pi-acp`) is not installed or not on PATH.",
      },
    });
  }

  const versionResult = yield* runPiCommand(piSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Pi (`pi`) is not installed or not on PATH."
          : "Failed to execute the Pi health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi timed out while reporting its version.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  const modelsResult = yield* runPiCommand(piSettings, ["--list-models"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const discovered =
    Result.isSuccess(modelsResult) && Option.isSome(modelsResult.success)
      ? parsePiModelList(modelsResult.success.value.stdout)
      : [];
  const models = modelsFromSettings(piSettings, discovered);

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: versionOutput.code === 0,
      version,
      status: versionOutput.code === 0 && models.length > 0 ? "ready" : "error",
      auth: { status: models.length > 0 ? "authenticated" : "unauthenticated" },
      ...(models.length === 0
        ? { message: "Pi has no authenticated models available. Configure Pi, then refresh." }
        : {}),
    },
  });
});
