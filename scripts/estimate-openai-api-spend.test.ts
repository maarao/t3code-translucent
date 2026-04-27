import { assert, it } from "@effect/vitest";

import {
  MODEL_PRICING,
  addTokenUsage,
  calculateUsageCost,
  isDedicatedReviewSource,
  readModelFromSelectionJson,
  resolveLastDaysWindow,
  resolveEffectiveWindow,
} from "./estimate-openai-api-spend.ts";

it("calculates cached-input discounted cost", () => {
  const usage = calculateUsageCost(
    {
      inputTokens: 1_396_548_218,
      cachedInputTokens: 1_346_180_096,
      outputTokens: 2_929_306,
    },
    MODEL_PRICING["gpt-5.4"],
  );

  assert.equal(usage.uncachedInputTokens, 50_368_122);
  assert.equal(Math.round(usage.estimatedCostUsd * 1_000_000), 506_404_919);
});

it("includes GPT-5.5 pricing", () => {
  const usage = calculateUsageCost(
    {
      inputTokens: 1_396_548_218,
      cachedInputTokens: 1_346_180_096,
      outputTokens: 2_929_306,
    },
    MODEL_PRICING["gpt-5.5"],
  );

  assert.equal(usage.uncachedInputTokens, 50_368_122);
  assert.equal(Math.round(usage.estimatedCostUsd * 1_000_000), 1_012_809_838);
});

it("adds token usage without mutating either side", () => {
  const left = {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 1,
  };
  const right = {
    inputTokens: 20,
    cachedInputTokens: 8,
    outputTokens: 3,
  };

  assert.deepStrictEqual(addTokenUsage(left, right), {
    inputTokens: 30,
    cachedInputTokens: 12,
    outputTokens: 4,
  });
  assert.deepStrictEqual(left, {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 1,
  });
});

it("identifies dedicated review sources", () => {
  assert.equal(isDedicatedReviewSource('{"subagent":"review"}'), true);
  assert.equal(isDedicatedReviewSource('{"subagent":"worker"}'), false);
  assert.equal(isDedicatedReviewSource("not-json"), false);
});

it("reads models from persisted model selections", () => {
  assert.equal(readModelFromSelectionJson('{"provider":"codex","model":"gpt-5.5"}'), "gpt-5.5");
  assert.equal(readModelFromSelectionJson('{"provider":"codex"}'), null);
  assert.equal(readModelFromSelectionJson(null), null);
});

it("applies explicit window bounds over observed activity bounds", () => {
  assert.deepStrictEqual(
    resolveEffectiveWindow(
      {
        start: "2026-03-31T22:50:13.799Z",
        end: "2026-04-15T20:36:55.767Z",
      },
      {
        end: "2026-04-16T00:00:00.000Z",
      },
    ),
    {
      start: "2026-03-31T22:50:13.799Z",
      end: "2026-04-16T00:00:00.000Z",
    },
  );
});

it("derives a rolling last-days window ending at the supplied current time", () => {
  assert.deepStrictEqual(resolveLastDaysWindow(15, new Date("2026-04-15T22:41:02.659Z")), {
    start: "2026-03-31T22:41:02.659Z",
    end: "2026-04-15T22:41:02.659Z",
  });
});
