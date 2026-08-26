import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowUpRight, FolderGit2, Gauge, Rows3, UserRound } from "lucide-react";
import { Link, useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import type { CapabilitiesResponse, HomeResponse, JobSummary, Tone } from "../api/types";
import {
  ErrorState,
  formatDate,
  InlineLink,
  PageHeader,
  Panel,
  PanelHeader,
  sentenceCase,
  StatePanel,
  StatusPill,
  stateTone,
} from "../components/ui";
import styles from "../styles/hub.module.css";

interface MetricView {
  id: string;
  label: string;
  value: number | string;
  detail: string;
  tone?: Tone;
  route?: string;
}

function MetricCard({ metric }: { metric: MetricView }) {
  const contents = (
    <>
      <div className={styles.metricTopline}><span>{metric.label}</span><Gauge aria-hidden="true" /></div>
      <strong>{metric.value}</strong>
      <p>{metric.detail}</p>
    </>
  );
  if (metric.route) {
    return (
      <Link className={styles.metricCard} data-tone={metric.tone ?? "neutral"} to={metric.route}>
        {contents}
      </Link>
    );
  }
  return (
    <article className={styles.metricCard} data-tone={metric.tone ?? "neutral"}>
      {contents}
    </article>
  );
}

function JobMiniRow({ job }: { job: JobSummary }) {
  return (
    <Link className={styles.jobMiniRow} to={`/jobs?job=${encodeURIComponent(job.id)}`}>
      <span className={styles.jobMiniIcon}><Rows3 aria-hidden="true" /></span>
      <span className={styles.jobMiniMain}>
        <strong>{sentenceCase(job.kind)}</strong>
        <small className={styles.mono}>{job.id}</small>
      </span>
      <StatusPill tone={stateTone(job.state)}>{job.cancelRequested ? "Cancelling" : sentenceCase(job.state)}</StatusPill>
      <time>{formatDate(job.finishedAt ?? job.startedAt ?? job.createdAt)}</time>
    </Link>
  );
}

function actorName(actor: HomeResponse["actor"]): string {
  if (actor.kind === "member") return actor.displayName;
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown actor";
}

function attentionTone(tone: HomeResponse["attention"][number]["tone"]): Tone {
  if (tone === "critical") return "danger";
  return tone;
}

export function HomePage() {
  const api = useHubApi();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const home = useQuery({ queryKey: ["home"], queryFn: () => api.getHome(), retry: false });
  const jobs = useQuery({ queryKey: ["jobs", "home"], queryFn: () => api.getJobs(), retry: false });

  if (home.isPending) {
    return (
      <div className={styles.page}>
        <PageHeader eyebrow="Repository overview" title="Good context starts here." description="A bounded view of the current local project." />
        <StatePanel state="loading" title="Reading local project state" detail="Checking only the repositories and indexes available to this Hub process." />
      </div>
    );
  }
  if (home.isError) {
    return <div className={styles.page}><PageHeader eyebrow="Repository overview" title="Good context starts here." description="A bounded view of the current local project." /><ErrorState error={home.error} retry={() => void home.refetch()} /></div>;
  }

  const data = home.data;
  const sections = Object.entries(data.sections) as Array<[keyof HomeResponse["sections"], HomeResponse["sections"][keyof HomeResponse["sections"]]]>;
  const metrics: MetricView[] = [
    { id: "jobs", label: "Active jobs", value: data.activeJobs, detail: data.activeJobs === 1 ? "One local operation in progress" : `${data.activeJobs} local operations in progress`, tone: data.activeJobs ? "info" : "neutral" },
    { id: "workstreams", label: "Workstreams", value: data.sections.workstreams.count ?? "—", detail: data.sections.workstreams.reason ?? "Durable project work", tone: data.sections.workstreams.availability === "unavailable" ? "warning" : "neutral" },
    { id: "activity", label: "Canonical events", value: data.sections.activity.count ?? "—", detail: data.sections.activity.reason ?? "Open immutable repository activity", tone: data.sections.activity.availability === "unavailable" ? "warning" : "neutral", route: "/activity" },
    { id: "tree", label: "Working tree", value: data.repository.dirty ? "Changed" : "Clean", detail: data.repository.branch ? `Branch ${data.repository.branch}` : "Detached or unknown branch", tone: data.repository.dirty ? "warning" : "success" },
  ];
  const sourcesUnavailable = capabilities
    && capabilities.graph.read.availability === "unavailable"
    && capabilities.wiki.read.availability === "unavailable";

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Repository overview"
        title="Good context starts here."
        description="A bounded view of project memory, repository activity, and local operations—without changing the working tree."
        actions={<InlineLink to="/search">Search this project</InlineLink>}
      />

      {sourcesUnavailable ? (
        <div className={styles.notice} role="status">
          <AlertCircle aria-hidden="true" />
          <span><strong>Knowledge and code indexes are unavailable.</strong>Repository context and local job history remain visible; unavailable sources are never replaced with sample data.</span>
          <Link to="/health">Review health</Link>
        </div>
      ) : null}

      <section className={styles.metricGrid} aria-label="Project summary">
        {metrics.map((metric) => <MetricCard key={metric.id} metric={metric} />)}
      </section>

      <div className={styles.overviewGrid}>
        <Panel className={styles.attentionPanel}>
          <PanelHeader eyebrow="Now" title="Needs attention" detail="Explicit warnings and follow-ups from available local sources." />
          {data.attention.length ? (
            <div className={styles.attentionList}>
              {data.attention.map((item) => (
                <article className={styles.attentionItem} key={item.id}>
                  <span className={styles.attentionMarker} data-tone={attentionTone(item.tone)} />
                  <div>
                    <div className={styles.attentionTitle}><strong>{item.title}</strong><StatusPill tone={attentionTone(item.tone)}>{sentenceCase(item.kind)}</StatusPill></div>
                    <p>{item.summary}</p>
                  </div>
                  <Link aria-label={`Open ${item.title}`} to={item.route}><ArrowUpRight aria-hidden="true" /></Link>
                </article>
              ))}
            </div>
          ) : (
            <StatePanel compact state="empty" title="Nothing needs attention" detail="No warnings or actionable items were returned." />
          )}
        </Panel>

        <Panel className={styles.activityPanel}>
          <PanelHeader eyebrow="Coverage" title="Project sections" detail="Unavailable sections remain explicit." />
          <div className={styles.sectionSummaryList}>
            {sections.map(([name, section]) => (
              <div className={styles.sectionSummary} key={name}>
                <span><strong>{sentenceCase(name)}</strong><small>{section.reason ?? "Connected local source"}</small></span>
                <StatusPill tone={section.availability === "available" ? "success" : "warning"}>{section.count ?? "Unavailable"}</StatusPill>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className={styles.repositoryPanel}>
          <PanelHeader eyebrow="Local context" title="Repository & actor" />
          <div className={styles.repositoryCardBody}>
            <span className={styles.largeGlyph}><FolderGit2 aria-hidden="true" /></span>
            <div><strong>{data.repository.name}</strong><p>{data.repository.branch ?? "Branch not reported"}</p></div>
            <span className={styles.largeGlyph}><UserRound aria-hidden="true" /></span>
            <div><strong>{actorName(data.actor)}</strong><p>{data.actor.kind === "member" ? "Configured team member" : data.actor.kind === "git" ? "Git identity fallback" : "No identity resolved"}</p></div>
          </div>
        </Panel>

        <Panel className={styles.jobsPanel}>
          <PanelHeader eyebrow="Operations" title="Recent jobs" action={<InlineLink to="/jobs">View all jobs</InlineLink>} />
          {jobs.isPending ? (
            <StatePanel compact state="loading" title="Reading job history" detail="Loading persisted summaries." />
          ) : jobs.isError ? (
            <ErrorState error={jobs.error} retry={() => void jobs.refetch()} />
          ) : jobs.data.items.length ? (
            <div className={styles.jobMiniList}>{jobs.data.items.slice(0, 4).map((job) => <JobMiniRow job={job} key={job.id} />)}</div>
          ) : (
            <StatePanel compact state="empty" title="No jobs recorded" detail="User-launched operations will appear here." />
          )}
        </Panel>
      </div>
    </div>
  );
}
