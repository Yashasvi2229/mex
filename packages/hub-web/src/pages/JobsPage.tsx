import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  DatabaseZap,
  LoaderCircle,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type { CapabilitiesResponse, JobKind, JobProgress, JobState, JobSummary } from "../api/types";
import {
  ErrorState,
  formatDate,
  PageHeader,
  Panel,
  sentenceCase,
  StatePanel,
  StatusPill,
  stateTone,
} from "../components/ui";
import styles from "../styles/hub.module.css";

const operations: Array<{ kind: JobKind; label: string; detail: string }> = [
  { kind: "graph_refresh", label: "Refresh graph", detail: "Re-stage the semantic code corpus" },
  { kind: "graph_rebuild", label: "Rebuild graph", detail: "Replace the derived graph safely" },
  { kind: "wiki_refresh", label: "Refresh Wiki", detail: "Update structured project memory" },
  { kind: "wiki_rebuild", label: "Rebuild Wiki", detail: "Recreate the derived Wiki index" },
];

type JobFilter = "all" | "active" | "history";

function isActive(job: JobSummary): boolean {
  return job.state === "queued" || job.state === "running";
}

function percentage(progress: JobProgress | null): number | null {
  if (!progress?.total) return null;
  return Math.max(0, Math.min(100, Math.round((progress.completed / progress.total) * 100)));
}

function operationCapability(capabilities: CapabilitiesResponse | undefined, kind: JobKind): { available: boolean; reason?: string } {
  if (!capabilities || capabilities.jobs.availability === "unavailable") {
    return { available: false, reason: capabilities?.jobs.reason ?? "Job execution is unavailable." };
  }
  const capability = kind === "graph_refresh"
    ? capabilities.graph.refresh
    : kind === "graph_rebuild"
      ? capabilities.graph.rebuild
      : kind === "wiki_rebuild"
        ? capabilities.wiki.rebuild
        : null;
  if (!capability) return { available: false, reason: "This build does not advertise a Wiki refresh executor." };
  return { available: capability.availability === "available", reason: capability.reason };
}

function JobStateIcon({ state }: { state: JobState }) {
  if (state === "succeeded") return <Check aria-hidden="true" />;
  if (state === "failed") return <X aria-hidden="true" />;
  if (state === "interrupted") return <Ban aria-hidden="true" />;
  if (state === "running") return <LoaderCircle aria-hidden="true" className={styles.spin} />;
  return <Clock3 aria-hidden="true" />;
}

function Progress({ job }: { job: JobSummary }) {
  const value = percentage(job.progress);
  return (
    <div className={styles.progressBlock}>
      <div>
        <span>{job.progress?.message ?? job.phase}</span>
        <span>{value === null ? (job.progress ? `${job.progress.completed} complete · total unknown` : "Total unknown") : `${value}%`}</span>
      </div>
      {value === null ? null : <progress aria-label={`${value}% complete`} className={styles.progressTrack} max={100} value={value}>{value}%</progress>}
    </div>
  );
}

function JobRow({ job, selected, onSelect }: { job: JobSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button
      aria-pressed={selected}
      className={`${styles.jobRow} ${selected ? styles.jobRowSelected : ""}`}
      data-job-id={job.id}
      onClick={onSelect}
      type="button"
    >
      <span className={styles.jobStateIcon} data-tone={stateTone(job.state)}><JobStateIcon state={job.state} /></span>
      <span className={styles.jobIdentity}>
        <span><strong>{sentenceCase(job.kind)}</strong><StatusPill tone={stateTone(job.state)}>{job.cancelRequested ? "Cancelling" : sentenceCase(job.state)}</StatusPill></span>
        <small className={styles.mono}>{job.id}</small>
      </span>
      <Progress job={job} />
      <time>{formatDate(job.finishedAt ?? job.startedAt ?? job.createdAt)}</time>
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

function JobDetail({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const detailRef = useRef<HTMLElement>(null);
  const job = useQuery({ queryKey: ["job", jobId], queryFn: () => api.getJob(jobId), retry: false });
  const cancel = useMutation({
    mutationFn: () => api.cancelJob(jobId),
    onSuccess: async (next) => {
      queryClient.setQueryData(["job", jobId], next);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  useEffect(() => {
    detailRef.current?.focus({ preventScroll: true });
  }, [jobId, job.isPending]);

  if (job.isPending) return <aside className={styles.jobDetail} ref={detailRef} tabIndex={-1}><StatePanel compact state="loading" title="Loading job" detail="Reading the persisted operation summary." /></aside>;
  if (job.isError) return <aside className={styles.jobDetail} ref={detailRef} tabIndex={-1}><ErrorState error={job.error} retry={() => void job.refetch()} /></aside>;
  const item = job.data;
  return (
    <aside className={styles.jobDetail} aria-label="Job detail" ref={detailRef} tabIndex={-1}>
      <div className={styles.detailHeader}>
        <div><p className={styles.panelEyebrow}>Operation detail</p><h2>{sentenceCase(item.kind)}</h2></div>
        <button aria-label="Close job detail" className={styles.iconButton} onClick={onClose} type="button"><X /></button>
      </div>
      <div className={styles.detailState}>
        <span className={styles.jobStateIcon} data-tone={stateTone(item.state)}><JobStateIcon state={item.state} /></span>
        <div><StatusPill tone={stateTone(item.state)}>{item.cancelRequested ? "Cancelling" : sentenceCase(item.state)}</StatusPill><small>{item.phase}</small></div>
      </div>
      <Progress job={item} />
      <dl className={styles.detailList}>
        <div><dt>Job ID</dt><dd className={styles.mono}>{item.id}</dd></div>
        {typeof item.generation === "number" ? <div><dt>Generation</dt><dd className={styles.mono}>{item.generation}</dd></div> : null}
        <div><dt>Created</dt><dd>{formatDate(item.createdAt)}</dd></div>
        {item.startedAt ? <div><dt>Started</dt><dd>{formatDate(item.startedAt)}</dd></div> : null}
        {item.finishedAt ? <div><dt>Finished</dt><dd>{formatDate(item.finishedAt)}</dd></div> : null}
        <div><dt>Revision</dt><dd className={styles.mono}>{item.revision.slice(0, 12)}</dd></div>
      </dl>
      {item.summary ? <div className={styles.detailNote}><strong>Summary</strong><p>{item.summary}</p></div> : null}
      {item.problem ? (
        <div className={styles.problemNote} role="alert">
          <strong>{item.problem.title ?? sentenceCase(item.problem.code)}</strong>
          {item.problem.detail ? <p>{item.problem.detail}</p> : null}
          <small className={styles.mono}>{item.problem.code}</small>
        </div>
      ) : null}
      {item.interruptedReason ? <div className={styles.detailNote}><strong>Interruption reason</strong><p>{sentenceCase(item.interruptedReason)}</p></div> : null}
      {item.cancelRequested && isActive(item) ? <div className={styles.detailNote} role="status"><strong>Cancellation requested</strong><p>The executor is stopping safely. This job remains active until it settles as interrupted.</p></div> : null}
      {isActive(item) ? (
        <button className={styles.dangerButton} disabled={cancel.isPending || item.cancelRequested} onClick={() => cancel.mutate()} type="button">
          <CircleStop aria-hidden="true" /> {cancel.isPending || item.cancelRequested ? "Cancelling…" : "Cancel job"}
        </button>
      ) : null}
      {cancel.isError ? <p className={styles.inlineProblem} role="alert">{cancel.error instanceof Error ? cancel.error.message : "Cancellation failed"}</p> : null}
    </aside>
  );
}

export function JobsPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("job");
  const previousSelectedId = useRef<string | null>(selectedId);
  const [filter, setFilter] = useState<JobFilter>("all");
  const jobs = useInfiniteQuery({
    queryKey: ["jobs"],
    queryFn: ({ pageParam }) => api.getJobs(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    retry: false,
  });
  const start = useMutation({
    mutationFn: (kind: JobKind) => api.startJob({ kind }),
    onSuccess: async (job) => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setParams({ job: job.id });
    },
  });

  const allJobs = useMemo(() => jobs.data?.pages.flatMap((page) => page.items) ?? [], [jobs.data]);
  const visibleJobs = allJobs.filter((job) => filter === "all" || (filter === "active" ? isActive(job) : !isActive(job)));
  const activeIds = allJobs.filter(isActive).map((job) => job.id).sort().join(",");

  useEffect(() => {
    if (!activeIds) return;
    const subscriptions = activeIds.split(",").map((id) => api.subscribeToJob(id, (snapshot) => {
      queryClient.setQueryData(["job", id], snapshot);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }));
    return () => subscriptions.forEach((subscription) => subscription.close());
  }, [activeIds, api, queryClient]);

  useEffect(() => {
    const previous = previousSelectedId.current;
    previousSelectedId.current = selectedId;
    if (previous !== null && selectedId === null) {
      document.querySelector<HTMLElement>(`[data-job-id="${previous}"]`)?.focus({ preventScroll: true });
    }
  }, [selectedId]);

  const contention = start.error instanceof HubApiError && start.error.problem.code === "JOB_ALREADY_RUNNING"
    ? start.error.problem
    : null;

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Local operations"
        title="Jobs"
        description="Explicit, persisted work with honest progress. Unknown totals stay unknown, and interrupted work remains visible after restart."
      />

      <section className={styles.operationStrip} aria-label="Start an operation">
        <div className={styles.operationIntro}><span><DatabaseZap aria-hidden="true" /></span><div><strong>Start local work</strong><p>Only supported executors can run.</p></div></div>
        {operations.map((operation) => {
          const capability = operationCapability(capabilities, operation.kind);
          return (
            <button
              className={styles.operationButton}
              disabled={!capability.available || start.isPending}
              key={operation.kind}
              onClick={() => start.mutate(operation.kind)}
              title={!capability.available ? (capability.reason ?? `${operation.label} is unavailable in this build`) : operation.detail}
              type="button"
            >
              {start.isPending && start.variables === operation.kind ? <LoaderCircle className={styles.spin} /> : <Play />}
              <span><strong>{operation.label}</strong><small>{capability.available ? operation.detail : "Capability unavailable"}</small></span>
            </button>
          );
        })}
      </section>

      {contention ? (
        <div className={styles.notice} data-tone="warning" role="alert">
          <RotateCcw aria-hidden="true" />
          <span><strong>An index operation is already running.</strong>The active job must finish or be cancelled before another starts.</span>
          <button onClick={() => setFilter("active")} type="button">Show active jobs</button>
        </div>
      ) : start.isError ? <ErrorState error={start.error} /> : null}

      <div className={`${styles.jobsWorkspace} ${selectedId ? styles.jobsWorkspaceOpen : ""}`}>
        <Panel className={styles.jobsListPanel}>
          <div className={styles.listToolbar}>
            <div><p className={styles.panelEyebrow}>Persisted history</p><h2>Operation log</h2></div>
            <div className={styles.segmented} aria-label="Filter jobs">
              {(["all", "active", "history"] as const).map((value) => (
                <button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} type="button">{sentenceCase(value)}</button>
              ))}
            </div>
          </div>
          {jobs.isPending ? (
            <StatePanel compact state="loading" title="Loading jobs" detail="Reading persisted job summaries." />
          ) : jobs.isError ? (
            <ErrorState error={jobs.error} retry={() => void jobs.refetch()} />
          ) : visibleJobs.length ? (
            <div className={styles.jobRows}>
              {visibleJobs.map((job) => (
                <JobRow
                  job={job}
                  key={job.id}
                  onSelect={() => setParams({ job: job.id })}
                  selected={selectedId === job.id}
                />
              ))}
              {jobs.hasNextPage ? (
                <button className={styles.loadMore} disabled={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()} type="button">
                  {jobs.isFetchingNextPage ? "Loading…" : "Load older jobs"}
                </button>
              ) : null}
            </div>
          ) : (
            <StatePanel compact state="empty" title={allJobs.length ? `No ${filter} jobs` : "No jobs recorded"} detail={allJobs.length ? "Choose another filter to see recorded work." : "Start a supported operation to create the first persisted job."} />
          )}
        </Panel>
        {selectedId ? <JobDetail jobId={selectedId} onClose={() => setParams({})} /> : null}
      </div>
    </div>
  );
}
