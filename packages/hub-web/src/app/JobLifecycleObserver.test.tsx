import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { JobLifecycleObserver } from "./JobLifecycleObserver";

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

  readonly name: string;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    const channels = FakeBroadcastChannel.channels.get(name) ?? new Set();
    channels.add(this);
    FakeBroadcastChannel.channels.set(name, channels);
  }

  postMessage(data: unknown): void {
    for (const channel of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (channel !== this) channel.onmessage?.({ data } as MessageEvent<unknown>);
    }
  }

  close(): void {
    const channels = FakeBroadcastChannel.channels.get(this.name);
    channels?.delete(this);
    if (channels?.size === 0) FakeBroadcastChannel.channels.delete(this.name);
  }
}

function renderObserver(api: HubApi, queryClient: QueryClient, channelScope?: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <JobLifecycleObserver channelScope={channelScope} />
      </HubApiProvider>
    </QueryClientProvider>,
  );
}

describe("JobLifecycleObserver", () => {
  it("loads lifecycle state once without registering a timer poll", async () => {
    const getJobs = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const subscribeToJob = vi.fn();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const api = { getJobs, subscribeToJob } as unknown as HubApi;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    renderObserver(api, queryClient);

    await act(async () => {
      await Promise.resolve();
    });
    expect(getJobs).toHaveBeenCalledTimes(1);
    expect(subscribeToJob).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("discovers another tab's job over a bounded same-origin channel without polling", async () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const fixture = createFixtureApi();
    const jobs = await fixture.getJobs();
    const running = jobs.items.find((job) => job.kind === "graph_refresh" && job.state === "running");
    if (!running) throw new Error("Expected a running graph fixture job.");
    let publishFromSecondTab: ((job: typeof running) => void) | undefined;
    const firstSubscribe = vi.fn(() => ({ close() {} }));
    const secondSubscribe = vi.fn((_id: string, onSnapshot: (job: typeof running) => void) => {
      publishFromSecondTab = onSnapshot;
      return { close() {} };
    });
    const firstApi = {
      getJobs: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      subscribeToJob: firstSubscribe,
    } as unknown as HubApi;
    const secondApi = {
      getJobs: vi.fn().mockResolvedValue({ items: [running], nextCursor: null }),
      subscribeToJob: secondSubscribe,
    } as unknown as HubApi;
    const firstClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const secondClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = renderObserver(firstApi, firstClient, "2026-08-26T12:00:00.000Z");
    const second = renderObserver(secondApi, secondClient, "2026-08-26T12:00:00.000Z");
    const invalidateFirst = vi.spyOn(firstClient, "invalidateQueries");

    try {
      await waitFor(() => expect(secondSubscribe).toHaveBeenCalledWith(running.id, expect.any(Function)));
      await act(async () => publishFromSecondTab?.(running));
      await waitFor(() => expect(firstSubscribe).toHaveBeenCalledWith(running.id, expect.any(Function)));

      await act(async () => publishFromSecondTab?.({
        ...running,
        state: "succeeded",
        phase: "publish",
        finishedAt: "2026-08-26T12:01:00.000Z",
      }));
      await waitFor(() => expect(invalidateFirst).toHaveBeenCalledWith({ queryKey: ["search"] }));
      expect(firstApi.getJobs).toHaveBeenCalledTimes(1);
    } finally {
      first.unmount();
      second.unmount();
      vi.unstubAllGlobals();
      FakeBroadcastChannel.channels.clear();
    }
  });
});
