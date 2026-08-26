import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, Database, RefreshCw } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import type { CapabilitiesResponse, HealthResponse, JobKind } from "../api/types";
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

function HealthRow({
  component,
  onAction,
  actionPending,
  actionAvailable,
}: {
  component: HealthComponent;
  onAction: (kind: JobKind) => void;
  actionPending: boolean;
  actionAvailable: boolean;
}) {
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
      </div>
      <div className={styles.healthAside}>
        {component.repairJobKind ? (
          <button
            className={styles.secondaryButton}
            disabled={!actionAvailable || actionPending}
            onClick={() => onAction(component.repairJobKind!)}
            title={!actionAvailable ? "This repair executor is unavailable in the current build" : undefined}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={actionPending ? styles.spin : ""} />
            {actionPending ? "Starting…" : sentenceCase(component.repairJobKind)}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function HealthPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.getHealth(), retry: false });
  const start = useMutation({
    mutationFn: (kind: JobKind) => api.startJob({ kind }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["health"] }), queryClient.invalidateQueries({ queryKey: ["jobs"] })]);
    },
  });

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
                actionAvailable={component.repairJobKind ? operationAvailable(capabilities, component.repairJobKind) : false}
                actionPending={start.isPending && start.variables === component.repairJobKind}
                component={component}
                key={component.id}
                onAction={(kind) => start.mutate(kind)}
              />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
