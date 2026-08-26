import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useHubApi } from "../api/context";
import type { JobKind, JobSummary, JobsResponse } from "../api/types";

export function isActiveJob(job: JobSummary): boolean {
  return job.state === "queued" || job.state === "running";
}

export function isGraphJob(kind: JobKind): kind is "graph_refresh" | "graph_rebuild" {
  return kind === "graph_refresh" || kind === "graph_rebuild";
}

export function isWikiJob(kind: JobKind): kind is "wiki_refresh" | "wiki_rebuild" {
  return kind === "wiki_refresh" || kind === "wiki_rebuild";
}

export async function invalidateGraphReads(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["search"] }),
    queryClient.invalidateQueries({ queryKey: ["code-symbol"] }),
    queryClient.invalidateQueries({ queryKey: ["health"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
  ]);
}

export async function invalidateWikiReads(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["search"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-entities"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-entity"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-relations"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-backlinks"] }),
    queryClient.invalidateQueries({ queryKey: ["code-knowledge"] }),
    queryClient.invalidateQueries({ queryKey: ["health"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
  ]);
}

export async function invalidateIndexOperationState(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["health"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
  ]);
}

async function invalidateTerminalJob(queryClient: QueryClient, job: JobSummary): Promise<void> {
  if (job.state === "succeeded" && isGraphJob(job.kind)) return invalidateGraphReads(queryClient);
  if (job.state === "succeeded" && isWikiJob(job.kind)) return invalidateWikiReads(queryClient);
  return invalidateIndexOperationState(queryClient);
}

/**
 * Own durable index-job observation for the lifetime of the authenticated app.
 * This keeps terminal cache invalidation alive when users leave the Jobs route.
 */
export function JobLifecycleObserver() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const initialTerminalIds = useRef<Set<string> | null>(null);
  const observedTerminal = useRef(new Set<string>());
  const lifecycle = useQuery({
    queryKey: ["job-lifecycle"],
    queryFn: async () => {
      const page = await api.getJobs();
      if (initialTerminalIds.current === null) {
        initialTerminalIds.current = new Set(page.items.filter((job) => !isActiveJob(job)).map((job) => job.id));
      }
      return page;
    },
    retry: false,
    refetchInterval: 5_000,
  });
  const activeIds = useMemo(
    () => lifecycle.data?.items.filter(isActiveJob).map((job) => job.id).sort().join(",") ?? "",
    [lifecycle.data],
  );

  useEffect(() => {
    if (!lifecycle.data) return;
    const terminal = lifecycle.data.items.filter((job) => !isActiveJob(job));
    const unseen = terminal.filter((job) => (
      !observedTerminal.current.has(job.id)
      && !initialTerminalIds.current?.has(job.id)
    ));
    for (const job of terminal) observedTerminal.current.add(job.id);
    if (!unseen.length) return;
    void Promise.all(unseen.map((job) => invalidateTerminalJob(queryClient, job)));
  }, [lifecycle.data, queryClient]);

  useEffect(() => {
    if (!activeIds) return;
    const subscriptions = activeIds.split(",").map((id) => api.subscribeToJob(id, (snapshot) => {
      queryClient.setQueryData(["job", id], snapshot);
      queryClient.setQueryData<JobsResponse>(["job-lifecycle"], (current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === snapshot.id ? snapshot : item),
      } : current);

      if (isActiveJob(snapshot)) {
        void queryClient.invalidateQueries({ queryKey: ["jobs"] });
        return;
      }
      if (observedTerminal.current.has(snapshot.id)) return;
      observedTerminal.current.add(snapshot.id);
      void invalidateTerminalJob(queryClient, snapshot).then(() => queryClient.invalidateQueries({ queryKey: ["job-lifecycle"] }));
    }));
    return () => subscriptions.forEach((subscription) => subscription.close());
  }, [activeIds, api, queryClient]);

  return null;
}
