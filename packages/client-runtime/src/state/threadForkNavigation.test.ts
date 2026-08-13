import {
  EnvironmentId,
  EventId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  armThreadForkNavigation,
  consumeThreadForkNavigation,
  latestThreadForkNavigationTarget,
} from "./threadForkNavigation.ts";

function activity(input: {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "info",
    kind: input.kind,
    summary: "Activity",
    payload: input.payload,
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

describe("latestThreadForkNavigationTarget", () => {
  afterEach(() => {
    consumeThreadForkNavigation({ environmentId, threadId, activities: [] });
  });

  it("returns the newest valid fork destination", () => {
    expect(
      latestThreadForkNavigationTarget([
        activity({ id: "fork-old", kind: "thread.forked", payload: { destinationThreadId: "a" } }),
        activity({ id: "other", kind: "runtime.warning", payload: {} }),
        activity({ id: "fork-new", kind: "thread.forked", payload: { destinationThreadId: "b" } }),
      ]),
    ).toEqual({
      activityId: "fork-new",
      destinationThreadId: ThreadId.make("b"),
    });
  });

  it("ignores malformed and unrelated activities", () => {
    expect(
      latestThreadForkNavigationTarget([
        activity({ id: "other", kind: "runtime.warning", payload: {} }),
        activity({ id: "bad", kind: "thread.forked", payload: { destinationThreadId: null } }),
      ]),
    ).toBeNull();
  });

  it("navigates only after the local client arms a newer fork", () => {
    const baseline = [
      activity({ id: "fork-old", kind: "thread.forked", payload: { destinationThreadId: "a" } }),
    ];
    armThreadForkNavigation({ environmentId, threadId, activities: baseline });

    expect(
      consumeThreadForkNavigation({ environmentId, threadId, activities: baseline }),
    ).toBeNull();
    expect(
      consumeThreadForkNavigation({
        environmentId,
        threadId,
        activities: [
          ...baseline,
          activity({
            id: "fork-new",
            kind: "thread.forked",
            payload: { destinationThreadId: "b" },
          }),
        ],
      }),
    ).toEqual({ activityId: "fork-new", destinationThreadId: ThreadId.make("b") });
  });
});
