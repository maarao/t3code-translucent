import { ThreadId, type EnvironmentId, type OrchestrationThreadActivity } from "@t3tools/contracts";

export interface ThreadForkNavigationTarget {
  readonly activityId: string;
  readonly destinationThreadId: ThreadId;
}

interface ArmedThreadForkNavigation {
  readonly baselineActivityId: string | null;
}

const armedThreadForkNavigations = new Map<string, ArmedThreadForkNavigation>();

function navigationKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

export function latestThreadForkNavigationTarget(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadForkNavigationTarget | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "thread.forked") continue;
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as { destinationThreadId?: unknown })
        : undefined;
    if (typeof payload?.destinationThreadId !== "string" || !payload.destinationThreadId.trim()) {
      continue;
    }
    return {
      activityId: activity.id,
      destinationThreadId: ThreadId.make(payload.destinationThreadId),
    };
  }
  return null;
}

export function armThreadForkNavigation(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  armedThreadForkNavigations.set(navigationKey(input.environmentId, input.threadId), {
    baselineActivityId: latestThreadForkNavigationTarget(input.activities)?.activityId ?? null,
  });
}

export function consumeThreadForkNavigation(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const key = navigationKey(input.environmentId, input.threadId);
  const armed = armedThreadForkNavigations.get(key);
  if (!armed) return null;

  const latest = latestThreadForkNavigationTarget(input.activities);
  if (!latest || latest.activityId === armed.baselineActivityId) return null;
  armedThreadForkNavigations.delete(key);
  return latest;
}
