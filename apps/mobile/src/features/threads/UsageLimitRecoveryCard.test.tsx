import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type PressableProps = { children: ReactNode; disabled?: boolean; onPress: () => void };

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, disabled, onPress }: PressableProps) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";

const DAY_MS = 24 * 60 * 60 * 1000;

function failedThread(resetAt: string): EnvironmentThreadShell {
  return {
    id: "thread-1",
    updatedAt: new Date(0).toISOString(),
    snoozedUntil: null,
    latestRun: { runId: "run-1", completedAt: new Date(0).toISOString() },
    limitRecovery: null,
    runtime: { status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: resetAt },
  } as unknown as EnvironmentThreadShell;
}

describe("UsageLimitRecoveryCard", () => {
  it.each([false, true])(
    "disables Snooze after reset expiry with snooze initially %s",
    (snoozed) => {
      using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
      vi.useFakeTimers({ now: 0 });
      const container = document.createElement("div");
      const root = createRoot(container);
      using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
      const resetAt = new Date(30 * DAY_MS).toISOString();
      const thread = failedThread(resetAt);
      act(() =>
        root.render(
          <UsageLimitRecoveryCard
            thread={{
              ...thread,
              snoozedUntil: snoozed ? resetAt : null,
              limitRecovery: snoozed
                ? { runId: thread.latestRun!.runId, resetAt, autoResume: false, snooze: true }
                : null,
            }}
            environmentId={"env-1" as EnvironmentId}
          />,
        ),
      );
      const snooze = () =>
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Snooze until reset",
        );
      const wake = () =>
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Wake now",
        );
      expect((snoozed ? wake() : snooze())?.disabled).toBe(false);

      act(() => vi.advanceTimersByTime(30 * DAY_MS));

      expect(snooze()?.disabled).toBe(true);
      expect(wake()).toBeUndefined();
    },
  );
});
