import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CircleDot,
  FolderGit2,
  GitBranch,
  Rows3,
  Search as SearchIcon,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Link, useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  HomeResponse,
  JobSummary,
  TeamCurrentActorResponse,
  Tone,
} from "../api/types";
import {
  ErrorState,
  formatDate,
  PageHeader,
  sentenceCase,
  StatePanel,
  StatusPill,
  stateTone,
} from "../components/ui";
import { Badge } from "../components/primitives/badge";
import { buttonVariants } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/primitives/item";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/primitives/table";
import homeStyles from "../styles/home.module.css";

interface MetricView {
  id: string;
  label: string;
  value: number | string;
  detail: string;
  route?: string;
  icon: LucideIcon;
}

function HomeHeader() {
  return (
    <PageHeader
      title="Overview"
      actions={(
        <Link className={buttonVariants({ size: "sm", variant: "outline" })} to="/search">
          <SearchIcon data-icon="inline-start" aria-hidden="true" />
          Search
        </Link>
      )}
    />
  );
}

function MetricCard({ metric }: { metric: MetricView }) {
  const Icon = metric.icon;
  const card = (
    <Card className={homeStyles.metricCard} size="sm">
      <CardHeader className={homeStyles.metricHeader}>
        <CardTitle className={homeStyles.metricLabel}>{metric.label}</CardTitle>
        <CardAction className={homeStyles.metricIcon}><Icon aria-hidden="true" /></CardAction>
      </CardHeader>
      <CardContent className={homeStyles.metricContent}>
        <strong className={homeStyles.metricValue}>{metric.value}</strong>
        <span className={homeStyles.metricDetail}>{metric.detail}</span>
      </CardContent>
    </Card>
  );

  return metric.route ? (
    <Link className={homeStyles.metricLink} to={metric.route}>{card}</Link>
  ) : card;
}

function JobRow({ job }: { job: JobSummary }) {
  const label = sentenceCase(job.kind);
  return (
    <TableRow>
      <TableCell>
        <Link className={homeStyles.jobIdentity} to={`/jobs?job=${encodeURIComponent(job.id)}`}>
          <span>{label}</span>
          <small>{job.id}</small>
        </Link>
      </TableCell>
      <TableCell>
        <StatusPill tone={stateTone(job.state)}>
          {job.cancelRequested ? "Cancelling" : sentenceCase(job.state)}
        </StatusPill>
      </TableCell>
      <TableCell>
        <time className={homeStyles.jobTime}>{formatDate(job.finishedAt ?? job.startedAt ?? job.createdAt)}</time>
      </TableCell>
      <TableCell className={homeStyles.jobActionCell}>
        <Link
          aria-label={`Open ${label}`}
          className={buttonVariants({ size: "icon-xs", variant: "ghost" })}
          to={`/jobs?job=${encodeURIComponent(job.id)}`}
        >
          <ArrowUpRight aria-hidden="true" />
        </Link>
      </TableCell>
    </TableRow>
  );
}

function actorName(actor: HomeResponse["actor"]): string {
  if (actor.kind === "member") return actor.displayName;
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown actor";
}

function currentActorName(actor: TeamCurrentActorResponse["actor"]): string {
  if (actor.kind === "member") return actor.displayName ?? actor.memberId;
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
  const currentActor = useQuery({
    queryKey: ["actor", "current"],
    queryFn: () => api.getCurrentActor(),
    enabled: capabilities?.members.read.availability === "available",
    retry: false,
  });

  if (home.isPending) {
    return (
      <div className={homeStyles.page}>
        <HomeHeader />
        <StatePanel state="loading" title="Reading local project state" detail="Loading repository context and local indexes." />
      </div>
    );
  }

  if (home.isError) {
    return (
      <div className={homeStyles.page}>
        <HomeHeader />
        <ErrorState error={home.error} retry={() => void home.refetch()} />
      </div>
    );
  }

  const data = home.data;
  const sections = Object.entries(data.sections) as Array<[
    keyof HomeResponse["sections"],
    HomeResponse["sections"][keyof HomeResponse["sections"]],
  ]>;
  const metrics: MetricView[] = [
    {
      id: "jobs",
      label: "Active jobs",
      value: data.activeJobs,
      detail: data.activeJobs ? "In progress" : "Idle",
      icon: Rows3,
    },
    {
      id: "workstreams",
      label: "Workstreams",
      value: data.sections.workstreams.count ?? "—",
      detail: data.sections.workstreams.availability === "available" ? "Canonical delivery threads" : "Not connected",
      ...(data.sections.workstreams.availability === "available" ? { route: "/workstreams" } : {}),
      icon: FolderGit2,
    },
    {
      id: "activity",
      label: "Canonical events",
      value: data.sections.activity.count ?? "—",
      detail: "Repository activity",
      route: "/activity",
      icon: Activity,
    },
    {
      id: "tree",
      label: "Working tree",
      value: data.repository.dirty ? "Changed" : "Clean",
      detail: data.repository.branch ?? "Branch unavailable",
      icon: GitBranch,
    },
  ];
  const sourcesUnavailable = capabilities
    && capabilities.graph.read.availability === "unavailable"
    && capabilities.wiki.read.availability === "unavailable";

  return (
    <div className={homeStyles.page}>
      <HomeHeader />

      {sourcesUnavailable ? (
        <StatePanel
          compact
          state="unavailable"
          title="Knowledge and code indexes are unavailable."
          detail="Repository context and job history remain available."
          action={(
            <Link className={buttonVariants({ size: "sm", variant: "outline" })} to="/health">
              Health
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Link>
          )}
        />
      ) : null}

      <section className={homeStyles.summaryGrid} aria-label="Project summary">
        {metrics.map((metric) => <MetricCard key={metric.id} metric={metric} />)}
      </section>

      <div className={homeStyles.dashboardGrid}>
        <Card className={homeStyles.attentionCard} role="region" aria-labelledby="home-attention-heading">
          <CardHeader className={`${homeStyles.cardHeader} border-b`}>
            <CardTitle><h2 id="home-attention-heading">Needs attention</h2></CardTitle>
            <CardAction><Badge variant="outline">{data.attention.length}</Badge></CardAction>
          </CardHeader>
          <CardContent className={homeStyles.cardListContent}>
            {data.attention.length ? (
              <ItemGroup>
                {data.attention.map((item) => (
                  <div role="listitem" key={item.id}>
                    <Item render={<Link to={item.route} />} size="sm">
                      <ItemMedia variant="icon"><CircleDot aria-hidden="true" /></ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          <span>{item.title}</span>
                          <StatusPill tone={attentionTone(item.tone)}>{sentenceCase(item.kind)}</StatusPill>
                        </ItemTitle>
                        <ItemDescription>{item.summary}</ItemDescription>
                      </ItemContent>
                      <ItemActions><ArrowUpRight aria-hidden="true" /></ItemActions>
                    </Item>
                  </div>
                ))}
              </ItemGroup>
            ) : (
              <StatePanel compact state="empty" title="Nothing needs attention" detail="No actionable items were returned." />
            )}
          </CardContent>
        </Card>

        <Card className={homeStyles.coverageCard} role="region" aria-labelledby="home-coverage-heading">
          <CardHeader className={`${homeStyles.cardHeader} border-b`}>
            <CardTitle><h2 id="home-coverage-heading">Project sections</h2></CardTitle>
            <CardAction>
              {capabilities?.members.read.availability === "available" ? (
                <Link
                  aria-label={`Open member identity for ${currentActor.data ? currentActorName(currentActor.data.actor) : actorName(data.actor)}`}
                  className={buttonVariants({ size: "sm", variant: "ghost" })}
                  to="/members"
                >
                  <UserRound data-icon="inline-start" aria-hidden="true" />
                  {currentActor.data ? currentActorName(currentActor.data.actor) : actorName(data.actor)}
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </Link>
              ) : (
                <Badge variant="outline">
                  <UserRound data-icon="inline-start" aria-hidden="true" />
                  {actorName(data.actor)}
                </Badge>
              )}
            </CardAction>
          </CardHeader>
          <CardContent className={homeStyles.cardListContent}>
            <ItemGroup>
              {sections.map(([name, section]) => (
                <Item key={name} role="listitem" size="xs">
                  <ItemContent>
                    <ItemTitle>{sentenceCase(name)}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <StatusPill tone={section.availability === "available" ? "neutral" : "warning"}>
                      {section.count ?? "Unavailable"}
                    </StatusPill>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>

        <Card className={homeStyles.jobsCard} role="region" aria-labelledby="home-jobs-heading">
          <CardHeader className={`${homeStyles.cardHeader} border-b`}>
            <CardTitle><h2 id="home-jobs-heading">Recent jobs</h2></CardTitle>
            <CardAction>
              <Link className={buttonVariants({ size: "sm", variant: "ghost" })} to="/jobs">
                All jobs
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </CardAction>
          </CardHeader>
          {jobs.isPending ? (
            <CardContent><StatePanel compact state="loading" title="Reading job history" detail="Loading persisted summaries." /></CardContent>
          ) : jobs.isError ? (
            <CardContent><ErrorState error={jobs.error} retry={() => void jobs.refetch()} /></CardContent>
          ) : jobs.data.items.length ? (
            <CardContent className={homeStyles.tableContent}>
              <Table>
                <TableCaption className="sr-only">Recent persisted jobs</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Operation</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead><span className="sr-only">Open job</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.data.items.slice(0, 4).map((job) => <JobRow job={job} key={job.id} />)}
                </TableBody>
              </Table>
            </CardContent>
          ) : (
            <CardContent><StatePanel compact state="empty" title="No jobs recorded" detail="User-launched operations will appear here." /></CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
