import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { CheckCircle2, CircleDashed, Database, FileWarning, GitCompare, RefreshCw } from "lucide-react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import type { CapabilitiesResponse, GraphHealthDetails, HealthResponse, JobKind } from "../api/types";
import { RebuildConfirmation } from "../components/RebuildConfirmation";
import { ErrorState, formatDate, PageHeader, Panel, StatePanel, StatusPill, stateTone, sentenceCase } from "../components/ui";
import styles from "../styles/hub.module.css";

type HealthComponent = HealthResponse["components"][number];

function operationAvailable(capabilities: CapabilitiesResponse | undefined, kind: JobKind): boolean {
  if (!capabilities) return false;
  if (kind === "graph_refresh") return capabilities.graph.refresh.availability === "available";
  if (kind === "graph_rebuild") return capabilities.graph.rebuild.availability === "available";
  if (kind === "wiki_rebuild") return capabilities.wiki.rebuild.availability === "available";
  return false;
}

function HealthIcon({ status }: { status: string }) {
  if (status === "healthy") return <CheckCircle2 aria-hidden="true" />;
  if (status === "degraded") return <CircleDashed aria-hidden="true" />;
  return <Database aria-hidden="true" />;
}

function shortHead(value: string | null): string {
  return value ? value.slice(0, 10) : "Not indexed";
}

function GraphHealthReadout({ graph }: { graph: GraphHealthDetails }) {
  const allChanges = [...graph.changes.added, ...graph.changes.modified, ...graph.changes.deleted];
  const visibleChanges = allChanges.slice(0, 5);
  const additionalChangeCount = allChanges.length - visibleChanges.length;
  const changedSignals = [
    graph.changes.branchChanged ? "Branch changed" : null,
    graph.changes.manifestChanged ? "Manifest changed" : null,
    graph.changes.configChanged ? "Config changed" : null,
    graph.changes.grammarChanged ? "Grammar changed" : null,
  ].filter((value): value is string => value !== null);
  return (
    <div className={styles.graphHealthReadout}>
      <div className={styles.graphIndexBanner}>
        <span><small>Graph index status</small><strong>{sentenceCase(graph.indexStatus)}</strong></span>
        <StatusPill tone={stateTone(graph.indexStatus)}>{graph.recommendedJobKind ? `${sentenceCase(graph.recommendedJobKind)} recommended` : "No repair recommended"}</StatusPill>
      </div>
      <div className={styles.graphSnapshotCompare}>
        <div><small>Indexed snapshot</small><strong>{graph.indexedBranch ?? "Detached / unavailable"}</strong><code>{shortHead(graph.indexedHead)}</code></div>
        <GitCompare aria-hidden="true" />
        <div><small>Current repository</small><strong>{graph.currentBranch ?? "Detached / unborn"}</strong><code>{shortHead(graph.currentHead)}</code></div>
      </div>
      <div className={styles.graphHealthMetrics}>
        <span><small>Parse health</small><strong>{graph.parseHealth.ok}/{graph.parseHealth.total}</strong><em>{graph.parseHealth.failed} failed · {graph.parseHealth.partial} partial</em></span>
        <span><small>Repository delta</small><strong>{graph.changes.total}</strong><em>{graph.changes.added.length} added · {graph.changes.modified.length} modified · {graph.changes.deleted.length} deleted</em></span>
        <span><small>Last success</small><strong>{formatDate(graph.lastSuccessfulIndexAt)}</strong><em>Indexed {formatDate(graph.indexedAt)}</em></span>
      </div>
      <div className={styles.graphCompatibility}>
        <span>Schema <code>{graph.schemaVersion ?? "—"}</code></span>
        <span>Extractor <code>{graph.extractorVersion ?? "—"}</code></span>
        <span>Grammar <code>{graph.grammarVersion ?? "—"}</code></span>
      </div>
      {changedSignals.length || visibleChanges.length ? (
        <div className={styles.graphChangeEvidence}>
          <FileWarning aria-hidden="true" />
          <div>
            {changedSignals.length ? <p>{changedSignals.join(" · ")}</p> : null}
            {visibleChanges.length ? <ul>{visibleChanges.map((path) => <li className={styles.mono} key={path}>{path}</li>)}</ul> : null}
            {additionalChangeCount ? <small>{additionalChangeCount} additional changed path{additionalChangeCount === 1 ? "" : "s"} omitted from this compact readout.</small> : null}
            {graph.changes.truncated ? <small>Changed paths were shortened by the health response bound.</small> : null}
          </div>
        </div>
      ) : null}
      {graph.parseHealth.failedPaths.length ? (
        <div className={styles.graphFailedPaths}>
          <strong>Files with parse failures</strong>
          <ul>{graph.parseHealth.failedPaths.map((path) => <li className={styles.mono} key={path}>{path}</li>)}</ul>
          {graph.parseHealth.failedPathsTruncated ? <small>Additional failed paths were omitted.</small> : null}
        </div>
      ) : null}
    </div>
  );
}

function HealthRow({
  component,
  onAction,
  actionPending,
  actionAvailable,
}: {
  component: HealthComponent;
  onAction: (kind: JobKind) => void;
  actionPending: boolean;
  actionAvailable: (kind: JobKind) => boolean;
}) {
  const actions: JobKind[] = component.graph?.allowedJobKinds
    ?? (component.repairJobKind ? [component.repairJobKind] : []);
  return (
    <article className={styles.healthRow}>
      <span className={styles.healthIcon} data-tone={stateTone(component.status)}><HealthIcon status={component.status} /></span>
      <div className={styles.healthMain}>
        <div className={styles.healthTitle}><h2>{component.label}</h2><StatusPill tone={stateTone(component.status)}>{sentenceCase(component.status)}</StatusPill></div>
        <p>{component.summary}</p>
        {component.diagnostics.length ? (
          <ul className={styles.diagnosticList}>
            {component.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`} data-severity={diagnostic.severity}>{diagnostic.message}</li>)}
          </ul>
        ) : null}
        {component.graph ? <GraphHealthReadout graph={component.graph} /> : null}
      </div>
      <div className={styles.healthAside}>
        {component.graph?.activeJobId ? <Link className={styles.inlineLink} to={`/jobs?job=${component.graph.activeJobId}`}>View active job</Link> : null}
        {actions.map((kind) => (
          <button
            className={styles.secondaryButton}
            disabled={!actionAvailable(kind) || actionPending}
            key={kind}
            onClick={() => onAction(kind)}
            title={!actionAvailable(kind) ? "This graph operation is unavailable in the current build" : undefined}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={actionPending ? styles.spin : ""} />
            {actionPending ? "Starting…" : kind === "graph_refresh" ? "Refresh graph" : kind === "graph_rebuild" ? "Rebuild graph" : sentenceCase(kind)}
            {component.graph?.recommendedJobKind === kind ? <small>Recommended</small> : null}
          </button>
        ))}
      </div>
    </article>
  );
}

export function HealthPage() {
  const api = useHubApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const rebuildReturnFocus = useRef<HTMLElement | null>(null);
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.getHealth(), retry: false });
  const start = useMutation({
    mutationFn: (kind: JobKind) => api.startJob({ kind }),
    onSuccess: (job) => {
      setConfirmRebuild(false);
      navigate(`/jobs?job=${encodeURIComponent(job.id)}`);
      void Promise.all([queryClient.invalidateQueries({ queryKey: ["health"] }), queryClient.invalidateQueries({ queryKey: ["jobs"] })]);
    },
    onError: () => {
      setConfirmRebuild(false);
      rebuildReturnFocus.current?.focus({ preventScroll: true });
    },
  });

  function requestAction(kind: JobKind) {
    if (kind === "graph_rebuild") {
      rebuildReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmRebuild(true);
      return;
    }
    start.mutate(kind);
  }

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="System integrity"
        title="Health"
        description="Freshness and availability are reported without triggering hidden writes, refreshes, or rebuilds."
        actions={health.data ? <StatusPill tone={stateTone(health.data.status)}>{sentenceCase(health.data.status)}</StatusPill> : undefined}
      />
      {start.isError ? <ErrorState error={start.error} /> : null}
      {health.isPending ? (
        <StatePanel state="loading" title="Inspecting system health" detail="This is a read-only inspection of local repository services." />
      ) : health.isError ? (
        <ErrorState error={health.error} retry={() => void health.refetch()} />
      ) : (
        <Panel className={styles.healthPanel}>
          <div className={styles.healthOverview}>
            <span className={styles.healthOverviewIcon} data-tone={stateTone(health.data.status)}><HealthIcon status={health.data.status} /></span>
            <div><p className={styles.panelEyebrow}>Current assessment</p><h2>{sentenceCase(health.data.status)}</h2><p>{health.data.components.length} local services reported.</p></div>
            <time>Checked {formatDate(health.data.observedAt)}</time>
          </div>
          <div className={styles.healthList}>
            {health.data.components.map((component) => (
              <HealthRow
                actionAvailable={(kind) => operationAvailable(capabilities, kind) && (
                  !component.graph
                  || (component.graph.activeJobId === null && component.graph.allowedJobKinds.some((allowed) => allowed === kind))
                )}
                actionPending={start.isPending && start.variables !== undefined && (
                  component.graph?.allowedJobKinds.some((kind) => kind === start.variables)
                  || start.variables === component.repairJobKind
                )}
                component={component}
                key={component.id}
                onAction={requestAction}
              />
            ))}
          </div>
        </Panel>
      )}
      <RebuildConfirmation
        onCancel={() => {
          setConfirmRebuild(false);
          rebuildReturnFocus.current?.focus({ preventScroll: true });
        }}
        onConfirm={() => start.mutate("graph_rebuild")}
        open={confirmRebuild}
        pending={start.isPending && start.variables === "graph_rebuild"}
      />
    </div>
  );
}
