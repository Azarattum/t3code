import {
  TurnItemId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderDriverKind,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  deriveReportedModelSelection,
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  deriveResumableRunId,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  deriveUsageLimitNoticeRows,
  isBackgroundWorkStopPending,
  limitRecoveryOwnsSnooze,
  presentPendingBackgroundWork,
  presentProviderGoal,
  presentRunStop,
  threadRuntimeHasInterruptibleRun,
  withoutUsageLimitNoticeRows,
} from "./threadExecution.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

function run(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

describe("thread execution presentation", () => {
  it("derives the current root failure without inheriting errors from children or previous runs", () => {
    const failed = { ...run("limited", 1, "failed"), rootNodeId: NodeId.make("root") };
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed], turnItems: [item] };
    expect(deriveThreadRuntime(projection)).toMatchObject({
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(deriveResumableRunId(projection, deriveThreadRuntime(projection))).toBe(failed.id);
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, nodeId: NodeId.make("child") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({
        ...projection,
        runs: [{ ...failed, rootNodeId: NodeId.make("new-root") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, run("new", 2, "running")] }),
    ).toMatchObject({ status: "running", lastError: null, lastErrorClass: null });
  });

  // regression: #15029 working timers no longer reset on every background wake
  it("counts a wake run's activity from the start of the work it continues", () => {
    const workStartedAt = DateTime.makeUnsafe("2026-07-28T09:20:00.000Z");
    const wake = { ...run("wake", 2, "running"), workStartedAt };
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "completed"), wake] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T09:20:00.000Z");
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "running")] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T10:00:00.000Z");
  });

  it("keeps a subscription limit visible while later messages stay queued", () => {
    const failed = {
      ...run("limited", 1, "failed"),
      rootNodeId: NodeId.make("root"),
      completedAt: now,
    };
    const queued = run("queued", 2, "queued");
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed, queued], turnItems: [item] };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "failed",
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(deriveResumableRunId(projection, deriveThreadRuntime(projection))).toBe(failed.id);
    const cancelledQueued = {
      ...run("cancelled-queued", 3, "cancelled"),
      startedAt: null,
      completedAt: now,
    };
    expect(
      usageLimitBlockedRun([failed, queued, cancelledQueued], projection.turnItems, null)?.id,
    ).toBe(failed.id);
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, queued, cancelledQueued] }),
    ).toMatchObject({ status: "failed", lastErrorClass: "usage_limit" });
    const providerError = {
      ...projection,
      turnItems: [{ ...item, failure: { ...item.failure, class: "provider_error" as const } }],
    };
    expect(deriveThreadRuntime(providerError)).toMatchObject({
      status: "queued",
      lastErrorClass: null,
    });
    expect(deriveResumableRunId(providerError, deriveThreadRuntime(providerError))).toBeNull();
  });

  it("keeps live activity attached to an executing run when a newer run is queued", () => {
    const runningRun = run("run-running", 1, "running");
    const queuedRun = run("run-queued", 2, "queued");
    const projection = { ...v2Projection, runs: [queuedRun, runningRun], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(queuedRun.id);
    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: runningRun.id,
      status: "running",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("marks an open run whose provider turn already ended", () => {
    const attemptId = RunAttemptId.make("attempt-open");
    const openRun = { ...run("run-open", 1, "running"), activeAttemptId: attemptId };
    const providerTurn = (status: "running" | "failed") => ({
      id: ProviderTurnId.make("provider-turn-open"),
      providerThreadId: ProviderThreadId.make("provider-thread-open"),
      nodeId: NodeId.make("node-open"),
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status,
      startedAt: now,
      completedAt: status === "running" ? null : now,
    });
    const projection = (status: "running" | "failed") => ({
      ...v2Projection,
      runs: [openRun],
      providerTurns: [providerTurn(status)],
      updatedAt: now,
    });

    expect(deriveThreadActivityRun(projection("running"))?.turnEnded).toBeUndefined();
    expect(deriveThreadActivityRun(projection("failed"))).toMatchObject({
      status: "running",
      turnEnded: true,
    });
  });

  it("presents a held queue as the stopped run instead of queued work", () => {
    const interrupted = { ...run("run-interrupted", 1, "interrupted"), completedAt: now };
    const held = { ...run("run-held", 2, "queued"), queueHeld: true };
    const projection = { ...v2Projection, runs: [interrupted, held], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "interrupted",
      activeRunId: null,
    });
    expect(deriveResumableRunId(projection, deriveThreadRuntime(projection))).toBe(interrupted.id);

    const resumed = { ...projection, runs: [interrupted, { ...held, queueHeld: false }] };
    expect(deriveThreadRuntime(resumed)).toMatchObject({ status: "queued" });

    const onlyHeld = {
      ...projection,
      runs: [held],
      thread: { ...projection.thread, activeProviderThreadId: null },
    };
    expect(deriveLatestThreadRun(onlyHeld)).toBeNull();
    expect(deriveThreadRuntime(onlyHeld)).toBeNull();
  });

  it("does not expose a queued-only run as interruptible", () => {
    const queuedRun = run("run-queued", 1, "queued");
    const projection = { ...v2Projection, runs: [queuedRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: queuedRun.id,
      status: "queued",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "queued",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });
});

describe("presentRunStop", () => {
  const signal = (type: "run_interrupt_request" | "run_interrupt_result", runId: RunId) => ({
    id: TurnItemId.make(`${type}:${runId}`),
    threadId: v2Projection.thread.id,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: type === "run_interrupt_result" ? ("interrupted" as const) : ("completed" as const),
    title: "Interrupt",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type,
    message: "Stopped by user",
  });
  const running = run("run-stopping", 1, "running");
  const request = signal("run_interrupt_request", running.id);

  it.each([
    { name: "no Stop", runs: [running], turnItems: [], state: null },
    {
      name: "a Stop the agent is winding down",
      runs: [running],
      turnItems: [request],
      state: "stopping",
    },
    {
      name: "a Stop the provider never confirmed",
      runs: [running],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
    {
      name: "a Stop that ended the run",
      runs: [running],
      turnItems: [request, signal("run_interrupt_result", running.id)],
      state: null,
    },
    {
      name: "a settled run's background work still stopping",
      runs: [{ ...running, status: "completed" as const, completedAt: now }],
      turnItems: [request],
      state: null,
    },
    {
      name: "a settled run whose background work ignored Stop",
      runs: [{ ...running, status: "completed" as const, completedAt: now }],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
    {
      name: "a settled run whose background work ignored Stop, with a queued follow-up",
      runs: [
        { ...running, status: "completed" as const, completedAt: now },
        run("run-queued", 2, "queued"),
      ],
      turnItems: [{ ...request, unresponsiveAt: now }],
      state: "unresponsive",
    },
  ])("presents $name", ({ runs, turnItems, state }) => {
    expect(presentRunStop({ runs, turnItems })?.state ?? null).toBe(state);
  });
});

describe("deriveRunlessWorkStartedAt", () => {
  const later = DateTime.makeUnsafe("2026-07-28T10:05:00.000Z");
  const rootTurn = (
    status: OrchestrationV2ExecutionNode["status"],
    startedAt = now,
  ): OrchestrationV2ExecutionNode => ({
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn",
    status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt: null,
  });

  const nativeChild = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource: "provider" as const,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
  };

  it("times a provider-native subagent from its runless root turn while it works", () => {
    const projection = { ...nativeChild, nodes: [rootTurn("running", later)] };
    expect(deriveRunlessWorkStartedAt(projection)).toBe("2026-07-28T10:05:00.000Z");
    expect(deriveThreadRuntime(projection)).toBeNull();
  });

  it("ignores root turns that belong to a run, and threads the provider does not run", () => {
    const owned = { ...rootTurn("running"), runId: RunId.make("run-1") };
    expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [owned] })).toBeNull();
    expect(
      deriveRunlessWorkStartedAt({ ...v2Projection, nodes: [rootTurn("running")] }),
    ).toBeNull();
  });
});

describe("deriveProviderSubagentStatus", () => {
  const root = {
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn" as const,
    status: "completed" as const,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  };
  const child = (creationSource: "provider" | "mcp") => ({
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
    nodes: [root],
  });

  it("leaves T3 delegated tasks and ordinary threads alone", () => {
    expect(deriveProviderSubagentStatus(child("mcp"))).toBeNull();
    expect(deriveProviderSubagentStatus({ ...v2Projection, nodes: [root] })).toBeNull();
  });
});

describe("provider-reported model selection", () => {
  const selected = v2Projection.thread.modelSelection;
  const reported = { ...selected, options: [{ id: "reasoningEffort", value: "default" }] };
  const providerThread = {
    id: ProviderThreadId.make("active"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: selected.instanceId,
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: v2Projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    nativeMetadata: { modelSelection: reported },
  };
  const projection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, activeProviderThreadId: providerThread.id },
    providerThreads: [providerThread],
  };

  it("reads only the active provider thread's reported selection", () => {
    expect(deriveReportedModelSelection(projection)).toBe(reported);
    expect(
      deriveReportedModelSelection({
        ...projection,
        thread: { ...projection.thread, activeProviderThreadId: null },
      }),
    ).toBeNull();
    expect(
      deriveReportedModelSelection({
        ...projection,
        providerThreads: [
          { ...providerThread, providerInstanceId: ProviderInstanceId.make("other") },
        ],
      }),
    ).toBeNull();
  });
});

describe("isBackgroundWorkStopPending", () => {
  const tasks = [{ taskId: "dev-server" }];
  const sent = { threadKey: "env:thread", taskIds: ["dev-server"], retryAt: null };
  const accepted = { ...sent, retryAt: 10_000 };

  it("stays pending after acceptance while a stopped task is still listed", () => {
    expect(isBackgroundWorkStopPending(sent, "env:thread", tasks, false)).toBe(true);
    expect(isBackgroundWorkStopPending(accepted, "env:thread", tasks, false)).toBe(true);
  });

  it("ends once the stopped tasks leave, even if new work starts", () => {
    expect(isBackgroundWorkStopPending(accepted, "env:thread", [], false)).toBe(false);
    expect(isBackgroundWorkStopPending(accepted, "env:thread", [{ taskId: "next" }], false)).toBe(
      false,
    );
  });

  it("allows retry at the deadline even if a stopped task remains", () => {
    const request = { ...accepted, retryAt: 10_000 };
    expect(isBackgroundWorkStopPending(request, "env:thread", tasks, false)).toBe(true);
    expect(isBackgroundWorkStopPending(request, "env:thread", tasks, true)).toBe(false);
  });

  it("only applies to the thread that sent the Stop", () => {
    expect(isBackgroundWorkStopPending(null, "env:thread", tasks, false)).toBe(false);
    expect(isBackgroundWorkStopPending(sent, "env:other", tasks, false)).toBe(false);
  });
});

describe("presentProviderGoal", () => {
  it("rolls token counts that round to 1000k over to 1m", () => {
    const usage = (tokensUsed: number) =>
      presentProviderGoal(
        { objective: "Ship the feature", status: "active", tokensUsed, tokenBudget: 2_000_000 },
        true,
      ).usage;
    expect(usage(999_499)).toBe("999k / 2m tokens");
    expect(usage(999_500)).toBe("1m / 2m tokens");
    expect(usage(999_999)).toBe("1m / 2m tokens");
    expect(usage(1_000_000)).toBe("1m / 2m tokens");
    expect(
      presentProviderGoal(
        {
          objective: "Ship the feature",
          status: "paused",
          tokensUsed: 999_500,
          tokenBudget: 999_500,
        },
        false,
      ).usage,
    ).toBe("1m / 1m tokens");
  });
});

describe("presentPendingBackgroundWork", () => {
  it("names a command by its script, not the shell that wraps it", () => {
    const presentation = presentPendingBackgroundWork([
      {
        taskId: "call_1",
        kind: "command",
        description: `/bin/zsh -lc "mv a.ts b.ts\ncat > b.ts <<'EOF'\nexport {};\nEOF"`,
      },
    ]);
    expect(presentation?.items[0]?.label).toBe("mv a.ts b.ts\ncat > b.ts <<'EOF'\nexport {};\nEOF");
  });
});

describe("usage-limit notice rows", () => {
  const limited = {
    ...run("limited", 1, "failed"),
    rootNodeId: NodeId.make("root"),
    completedAt: now,
  };
  const providerTurnId = ProviderTurnId.make("provider-turn-limited");
  const base = {
    threadId: v2Projection.thread.id,
    runId: limited.id,
    nodeId: NodeId.make("assistant-node"),
    providerThreadId: null,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const assistant = (id: string, ordinal: number, text: string) => ({
    ...base,
    id: TurnItemId.make(id),
    ordinal,
    type: "assistant_message" as const,
    messageId: MessageId.make(`message-${id}`),
    text,
    streaming: false,
  });
  const error = (id: string, ordinal: number, overrides: object = {}) => ({
    ...base,
    id: TurnItemId.make(id),
    ordinal,
    nodeId: limited.rootNodeId,
    status: "failed" as const,
    type: "error" as const,
    failure: {
      class: "usage_limit" as const,
      message: "Claude usage limit reached. Send the message again once the limit resets.",
      code: "api_error_429",
      retryable: true,
      resetAt: "2026-07-28T13:10:00.000Z",
    },
    ...overrides,
  });
  const notice = (id: string, ordinal: number, nativeId: string) => ({
    ...base,
    id: TurnItemId.make(id),
    ordinal,
    nativeItemRef: {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeId,
      strength: "weak" as const,
    },
    type: "system_notice" as const,
    message: "Claude usage limit reached. This turn is paused until the 5-hour limit resets.",
  });
  const turnItems = [
    assistant("useful", 1, "I updated the parser and started on the tests."),
    notice("pause", 2, `usage-limit:${providerTurnId}:five_hour:1785258600`),
    notice("unrelated-notice", 3, "compaction:1"),
    error("child-error", 4, {
      nodeId: NodeId.make("child"),
      failure: { class: "provider_error", message: "Subagent failed", code: null, retryable: null },
    }),
    assistant("cli-notice", 5, "You've hit your 5-hour limit · resets 7:10am (Asia/Kolkata)"),
    error("limit-error", 6),
  ];
  const swap = (index: number, item: (typeof turnItems)[number]) =>
    turnItems.map((current, position) => (position === index ? item : current));
  const rows = (items: ReadonlyArray<(typeof turnItems)[number]>) =>
    items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: v2Projection.thread.id,
      sourceItemId: item.id,
      item,
    }));
  const visibleIds = (projection: typeof v2Projection) =>
    withoutUsageLimitNoticeRows(
      projection.visibleTurnItems,
      deriveUsageLimitNoticeRows(projection),
    ).map((row) => row.item.id);
  const projection = (runs: ReadonlyArray<OrchestrationV2Run>, items = turnItems) => ({
    ...v2Projection,
    runs,
    turnItems: items,
    visibleTurnItems: rows(items),
  });

  it("leaves the recovery notice as the only account of a usage-limit pause", () => {
    const kept = ["useful", "unrelated-notice", "child-error"];
    expect(visibleIds(projection([limited]))).toEqual(kept);
    // Follow-ups that never started do not end the pause.
    expect(visibleIds(projection([limited, run("queued", 2, "queued")]))).toEqual(kept);
    expect(
      visibleIds(projection([limited, { ...run("held", 2, "queued"), queueHeld: true }])),
    ).toEqual(kept);
    expect(
      visibleIds(
        projection([
          limited,
          { ...run("dropped", 2, "cancelled"), startedAt: null, completedAt: now },
        ]),
      ),
    ).toEqual(kept);
  });

  it("keeps the agent's own words in the limited turn", () => {
    const reply = assistant(
      "cli-notice",
      5,
      "I've hit your limit on retries, so here is the plan.",
    );
    expect(visibleIds(projection([limited], swap(4, reply)))).toContain("cli-notice");
    const earlierTurn = { ...turnItems[4]!, providerTurnId: ProviderTurnId.make("earlier-turn") };
    expect(visibleIds(projection([limited], swap(4, earlierTurn)))).toContain("cli-notice");
  });

  it("returns the rows to history once another run executes or the failure is not a usage limit", () => {
    const all = turnItems.map((item) => item.id);
    const next = { ...run("next", 2, "completed"), completedAt: now };
    expect(visibleIds(projection([limited, next]))).toEqual(all);
    expect(visibleIds(projection([limited, run("next", 2, "running")]))).toEqual(all);
    const providerError = error("limit-error", 6, {
      failure: { class: "provider_error", message: "Boom", code: null, retryable: null },
    });
    expect(visibleIds(projection([limited], swap(5, providerError)))).toEqual(all);
  });
});

describe("limitRecoveryOwnsSnooze", () => {
  const runId = RunId.make("limited");
  const resetAt = "2026-07-28T13:10:00.000Z";
  const owned = {
    runId,
    resetAt,
    recovery: { runId, resetAt, autoResume: true, snooze: true },
    snoozedUntil: resetAt,
  };

  it("belongs to the recovery only for the run and reset it snoozed", () => {
    expect(limitRecoveryOwnsSnooze(owned)).toBe(true);
    // Auto-resume and snooze are independent; cancelling one keeps the other.
    expect(
      limitRecoveryOwnsSnooze({ ...owned, recovery: { ...owned.recovery, autoResume: false } }),
    ).toBe(true);
    expect(
      limitRecoveryOwnsSnooze({ ...owned, recovery: { ...owned.recovery, snooze: false } }),
    ).toBe(false);
    expect(limitRecoveryOwnsSnooze({ ...owned, snoozedUntil: "2026-07-29T09:00:00.000Z" })).toBe(
      false,
    );
    expect(limitRecoveryOwnsSnooze({ ...owned, runId: RunId.make("later") })).toBe(false);
    expect(limitRecoveryOwnsSnooze({ ...owned, resetAt: "2026-07-28T14:10:00.000Z" })).toBe(false);
    expect(limitRecoveryOwnsSnooze({ ...owned, recovery: null })).toBe(false);
  });
});
