import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Box,
  Braces,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CircleDot,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  History,
  RotateCcw,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type {
  ActivityActor,
  ActivityDiagnostic,
  ActivityItem,
  ActivitySource,
  ActivitySubject,
  CapabilitiesResponse,
} from "../api/types";
import {
  ErrorState,
  PageHeader,
  StatePanel,
  StatusPill,
} from "../components/ui";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import { Card } from "../components/primitives/card";
import styles from "../styles/activity.module.css";
import hubStyles from "../styles/hub.module.css";

type ActivityFilter = "all" | ActivitySource;

const ACTIVITY_PAGE_SIZE = 25;

function validDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toSinceTimestamp(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function prettyAction(value: string): string {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function actorLabel(actor: ActivityActor): string {
  if (actor.kind === "member") return actor.displayName ?? actor.memberId;
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown actor";
}

function sameActor(left: ActivityActor, right: ActivityActor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unknown" || right.kind === "unknown") return true;
  if (left.kind === "member" && right.kind === "member") {
    return left.memberId === right.memberId && left.displayName === right.displayName;
  }
  if (left.kind === "git" && right.kind === "git") {
    return left.name === right.name && left.email === right.email;
  }
  return false;
}

function subjectLabel(subject: ActivitySubject): string {
  if (subject.kind === "entity") return subject.entity.title ?? subject.entity.id;
  if (subject.kind === "symbol") return subject.symbolId;
  if (subject.kind === "file") return subject.path;
  return subject.hash.slice(0, 12);
}

function SubjectIcon({ subject }: { subject: ActivitySubject }) {
  if (subject.kind === "entity") return <Box aria-hidden="true" />;
  if (subject.kind === "symbol") return <Braces aria-hidden="true" />;
  if (subject.kind === "file") return <FileText aria-hidden="true" />;
  return <GitCommitHorizontal aria-hidden="true" />;
}

function formatDay(timestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

function formatClock(timestamp: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(timestamp))} UTC`;
}

function repositoryLabel(item: Extract<ActivityItem, { source: "activity" }>): string {
  if (item.repository.branch) return item.repository.branch;
  if (item.repository.head) return "Detached HEAD";
  return "Unborn repository";
}

function SubjectChips({ item }: { item: ActivityItem }) {
  const visibleSubjects = item.subjects.slice(0, 3);
  const remaining = Math.max(0, item.subjectCount - visibleSubjects.length);
  if (visibleSubjects.length === 0) {
    if (item.subjectCount > 0) {
      return (
        <p
          aria-label={`${item.subjectCount} linked ${item.subjectCount === 1 ? "subject" : "subjects"}; previews omitted`}
          className={styles.activityNoSubjects}
        >
          {item.subjectCount} linked {item.subjectCount === 1 ? "subject" : "subjects"}; previews omitted
        </p>
      );
    }
    return <p className={styles.activityNoSubjects}>No linked subjects</p>;
  }
  return (
    <div className={styles.activitySubjectChips} aria-label={`${item.subjectCount} linked ${item.subjectCount === 1 ? "subject" : "subjects"}`}>
      {visibleSubjects.map((subject, index) => (
        <span className={styles.activitySubjectChip} key={`${subject.kind}-${subjectLabel(subject)}-${index}`}>
          <SubjectIcon subject={subject} />
          <span>{subjectLabel(subject)}</span>
        </span>
      ))}
      {remaining > 0 ? <span className={styles.activitySubjectMore}>+{remaining} more</span> : null}
    </div>
  );
}

function DetailValue({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return <dd className={mono ? styles.mono : undefined}>{children}</dd>;
}

function ActivityDetails({ item }: { item: ActivityItem }) {
  const canonical = item.source === "activity" ? item : null;
  const legacy = item.source === "legacy" ? item : null;
  return (
    <div className={styles.activityDetails}>
      <div className={styles.activityEvidenceHeader}>
        <p>Event evidence</p>
        <span>{canonical ? "Canonical record" : "Legacy record"}</span>
      </div>
      <dl className={styles.activityDetailGrid}>
        <div><dt>Action</dt><DetailValue mono>{item.action}</DetailValue></div>
        <div><dt>Event ID</dt><DetailValue mono>{item.id}</DetailValue></div>
        <div><dt>Source</dt><DetailValue mono>{item.sourcePath}</DetailValue></div>
        {canonical ? (
          <>
            <div><dt>Effective actor</dt><DetailValue>{actorLabel(canonical.effectiveActor)}</DetailValue></div>
            <div><dt>Recorded actor</dt><DetailValue>{actorLabel(canonical.recordedActor)}</DetailValue></div>
            <div><dt>Workstream</dt><DetailValue>{canonical.workstream?.title ?? canonical.workstream?.id ?? "Not linked"}</DetailValue></div>
            <div><dt>Revision</dt><DetailValue mono>{canonical.revision.slice(0, 12)}</DetailValue></div>
          </>
        ) : (
          <>
            <div><dt>Source line</dt><DetailValue>{legacy?.sourceLine ?? "Not recorded"}</DetailValue></div>
            <div><dt>Actor</dt><DetailValue>Not recorded</DetailValue></div>
            <div><dt>Repository state</dt><DetailValue>Not recorded</DetailValue></div>
          </>
        )}
      </dl>

      {canonical ? (
        <section className={styles.activityRepository} aria-label="Recorded repository state">
          <div>
            <GitBranch aria-hidden="true" />
            <span><small>Checkpoint</small><strong>{repositoryLabel(canonical)}</strong></span>
          </div>
          <div>
            <GitCommitHorizontal aria-hidden="true" />
            <span><small>HEAD</small><strong className={styles.mono}>{canonical.repository.head?.slice(0, 12) ?? "No HEAD yet"}</strong></span>
          </div>
          <StatusPill tone={canonical.repository.dirty ? "warning" : "success"}>
            {canonical.repository.dirty ? "Dirty tree" : "Clean tree"}
          </StatusPill>
          <time dateTime={canonical.repository.observedAt}>{formatClock(canonical.repository.observedAt)}</time>
        </section>
      ) : null}

      {item.subjectCount > 0 ? (
        <section className={styles.activitySubjectDetail} aria-label="Subject references">
          <p className={styles.sectionLabel}>Bounded subject references</p>
          {item.subjects.length > 0 ? (
            <>
              <ul>
                {item.subjects.map((subject, index) => (
                  <li key={`${subject.kind}-${subjectLabel(subject)}-${index}`}>
                    <span><SubjectIcon subject={subject} /></span>
                    <div><small>{subject.kind === "entity" ? subject.entity.entityKind : subject.kind}</small><strong className={subject.kind === "file" || subject.kind === "symbol" || subject.kind === "commit" ? styles.mono : undefined}>{subjectLabel(subject)}</strong></div>
                  </li>
                ))}
              </ul>
              {item.subjectsTruncated ? <p className={styles.activityBoundedNote}>Only {item.subjects.length} of {item.subjectCount} subject references are included in this bounded response.</p> : null}
            </>
          ) : (
            <p className={styles.activityBoundedNote}>
              {item.subjectCount} {item.subjectCount === 1 ? "subject reference was" : "subject references were"} recorded; previews were omitted by the response safety limits.
            </p>
          )}
        </section>
      ) : null}

      {canonical?.actorDiagnostics.length ? (
        <section className={styles.activityActorDiagnostics} aria-label="Actor resolution diagnostics">
          <p className={styles.sectionLabel}>Identity resolution</p>
          <ul>{canonical.actorDiagnostics.map((diagnostic) => <li key={`${diagnostic.code}-${diagnostic.message}`}><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span></li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function ActivityEntry({ item, expanded, onToggle }: { item: ActivityItem; expanded: boolean; onToggle: () => void }) {
  const detailsId = useId();
  const canonical = item.source === "activity" ? item : null;
  const legacy = item.source === "legacy" ? item : null;
  const effectiveActor = canonical ? actorLabel(canonical.effectiveActor) : "Not recorded";
  const actorRemapped = canonical ? !sameActor(canonical.recordedActor, canonical.effectiveActor) : false;
  const EntryIcon = canonical ? Activity : ScrollText;
  return (
    <li className={styles.activityEntry}>
      <time className={styles.activityEntryTime} dateTime={item.timestamp}>{formatClock(item.timestamp)}</time>
      <span className={styles.activityEntryMarker} data-source={item.source}><EntryIcon aria-hidden="true" /></span>
      <article className={styles.activityEntryCard} data-source={item.source}>
        <div className={styles.activityEntryTopline}>
          <Badge className={styles.activitySourceBadge} data-source={item.source} variant="outline">{canonical ? "Canonical" : "Legacy"}</Badge>
          {canonical?.workstream ? <span className={styles.activityWorkstream}>{canonical.workstream.title ?? canonical.workstream.id}</span> : null}
          {canonical?.actorDiagnostics.length ? <span className={styles.activityIdentityFlag}><CircleDot aria-hidden="true" /> Identity note</span> : null}
        </div>
        <h3>{canonical ? prettyAction(item.action) : legacy?.message || prettyAction(item.action)}</h3>
        {legacy?.messageTruncated ? <p className={styles.activityBoundedNote}>Legacy message shortened by the response safety limit.</p> : null}
        <p className={styles.activityActorLine}>
          {canonical ? <><strong>{effectiveActor}</strong><span>performed this recorded action</span></> : <><strong>{prettyAction(item.action)}</strong><span>Actor and repository state were not recorded</span></>}
        </p>
        {actorRemapped && canonical ? <p className={styles.activityRemap}>Recorded as {actorLabel(canonical.recordedActor)}</p> : null}
        <SubjectChips item={item} />
        <Button
          aria-controls={detailsId}
          aria-expanded={expanded}
          className={styles.activityDisclosure}
          onClick={onToggle}
          size="sm"
          type="button"
          variant="ghost"
        >
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          {expanded ? "Hide details" : "Show details"}
        </Button>
        {expanded ? <div id={detailsId}><ActivityDetails item={item} /></div> : null}
      </article>
    </li>
  );
}

function DiagnosticsNotice({
  diagnostics,
  hasTrustedItems,
  truncated,
}: {
  diagnostics: ActivityDiagnostic[];
  hasTrustedItems: boolean;
  truncated: boolean;
}) {
  if (diagnostics.length === 0 && !truncated) return null;
  return (
    <details className={styles.activityDiagnostics}>
      <summary>
        <AlertTriangle aria-hidden="true" />
        <span>
          <strong>Some history could not be trusted.</strong>{" "}
          {hasTrustedItems ? "Valid events remain visible." : "No trusted events are available in this result."}
        </span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <ul>
        {diagnostics.map((diagnostic) => (
          <li data-severity={diagnostic.severity} key={`${diagnostic.code}-${diagnostic.path ?? ""}-${diagnostic.message}`}>
            <strong>{diagnostic.code}</strong>
            <span>{diagnostic.message}{diagnostic.path ? <small className={styles.mono}>{diagnostic.path}</small> : null}</span>
          </li>
        ))}
      </ul>
      {truncated ? <p>Additional diagnostics were omitted by the response safety limit.</p> : null}
    </details>
  );
}

export function ActivityPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const focusAfterLoad = useRef(false);
  const resultStatusRef = useRef<HTMLDivElement>(null);
  const paramsString = params.toString();
  const sourceValues = params.getAll("source");
  const source: ActivityFilter = sourceValues.length === 1 && (sourceValues[0] === "activity" || sourceValues[0] === "legacy")
    ? sourceValues[0]
    : "all";
  const sinceValues = params.getAll("since");
  const since = sinceValues.length === 1 && validDate(sinceValues[0]) ? sinceValues[0] : "";
  const activityAvailable = capabilities?.activity.availability === "available";
  const queryKey = ["activity", source, since] as const;

  useEffect(() => {
    const normalized = new URLSearchParams(paramsString);
    let changed = false;
    if (sourceValues.length > 1 || (sourceValues.length === 1 && source === "all")) {
      normalized.delete("source");
      changed = true;
    }
    if (sinceValues.length > 1 || (sinceValues.length === 1 && since === "")) {
      normalized.delete("since");
      changed = true;
    }
    if (changed) setParams(normalized, { replace: true });
  }, [paramsString, setParams, since, sinceValues.length, source, sourceValues.length]);

  useEffect(() => setExpanded(new Set()), [since, source]);

  const timeline = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => api.getActivity({
      limit: ACTIVITY_PAGE_SIZE,
      ...(source === "all" ? {} : { source }),
      ...(since ? { since: toSinceTimestamp(since) } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: activityAvailable,
    retry: false,
  });

  const firstRevision = timeline.data?.pages[0]?.deterministicRevision;
  const revisionMismatch = timeline.data?.pages.some((page) => page.deterministicRevision !== firstRevision) ?? false;
  const trustedPages = revisionMismatch ? (timeline.data?.pages.slice(0, 1) ?? []) : (timeline.data?.pages ?? []);
  const items = useMemo(() => {
    const unique = new Map<string, ActivityItem>();
    for (const page of trustedPages) {
      for (const item of page.items) unique.set(`${item.source}:${item.id}`, item);
    }
    return [...unique.values()];
  }, [trustedPages]);
  const diagnostics = useMemo(() => {
    const unique = new Map<string, ActivityDiagnostic>();
    for (const page of trustedPages) {
      for (const diagnostic of page.diagnostics) {
        unique.set(`${diagnostic.code}\0${diagnostic.path ?? ""}\0${diagnostic.message}`, diagnostic);
      }
    }
    return [...unique.values()];
  }, [trustedPages]);
  const diagnosticsTruncated = trustedPages.some((page) => page.diagnosticsTruncated);
  const sourceTruncated = trustedPages.some((page) => page.sourceTruncated);
  const paginationConflict = revisionMismatch || (
    timeline.isFetchNextPageError
    && timeline.error instanceof HubApiError
    && timeline.error.problem.code === "REVISION_CONFLICT"
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, ActivityItem[]>();
    for (const item of items) {
      const key = item.timestamp.slice(0, 10);
      const existing = grouped.get(key);
      if (existing) existing.push(item);
      else grouped.set(key, [item]);
    }
    return [...grouped.entries()];
  }, [items]);

  useEffect(() => {
    if (focusAfterLoad.current && !timeline.isFetching && timeline.data !== undefined) {
      focusAfterLoad.current = false;
      resultStatusRef.current?.focus({ preventScroll: true });
    }
  }, [timeline.data, timeline.isFetching]);

  const updateSource = (value: ActivityFilter) => {
    focusAfterLoad.current = true;
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("source");
    else next.set("source", value);
    setParams(next);
  };
  const updateSince = (value: string) => {
    focusAfterLoad.current = true;
    const next = new URLSearchParams(params);
    if (value) next.set("since", value);
    else next.delete("since");
    setParams(next);
  };
  const reloadNewest = () => {
    focusAfterLoad.current = true;
    setExpanded(new Set());
    void queryClient.resetQueries({ queryKey, exact: true });
  };

  return (
    <div className={hubStyles.page}>
      <PageHeader
        title="Activity"
        actions={<Badge className={styles.readOnlyBadge} variant="outline"><ShieldCheck aria-hidden="true" /> Read only</Badge>}
      />

      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking activity capability" detail="Confirming that the local timeline reader is connected." />
      ) : !activityAvailable ? (
        <StatePanel state="unavailable" title="Activity is unavailable" detail={capabilities.activity.reason ?? "The read-only activity reader is not connected in this Hub process."} />
      ) : (
        <section aria-label="Activity timeline">
          <Card className={styles.activityWorkbench}>
            <header className={styles.activityToolbar}>
            <div className={styles.activitySourceControl}>
              <p className={styles.sectionLabel}>Timeline source</p>
              <div className={styles.segmented} aria-label="Filter activity source" role="group">
                {(["all", "activity", "legacy"] as const).map((value) => (
                  <Button
                    aria-pressed={source === value}
                    className={styles.sourceButton}
                    key={value}
                    onClick={() => updateSource(value)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {value === "all" ? "All" : value === "activity" ? "Canonical" : "Legacy"}
                  </Button>
                ))}
              </div>
            </div>
            <div className={styles.activityDateControl}>
              <label className={styles.activityDateField}>
                <span><CalendarDays aria-hidden="true" /> Since</span>
                <input onChange={(event) => updateSince(event.currentTarget.value)} type="date" value={since} />
              </label>
              {since ? <Button className={styles.activityClearFilter} onClick={() => updateSince("")} size="sm" type="button" variant="ghost">Clear date</Button> : null}
            </div>
            <div className={styles.activityLoadedCount} aria-live="polite" ref={resultStatusRef} role="status" tabIndex={-1}>
              <strong>{items.length}</strong>
              <span>{items.length === 1 ? "event loaded" : "events loaded"}</span>
            </div>
            </header>

            <div className={styles.activityResult}>
            {timeline.isPending ? (
              <div className={styles.activityState}>
                <StatePanel compact state="loading" title="Reading immutable history" detail="Combining bounded canonical activity and legacy rows." />
              </div>
            ) : timeline.isError && timeline.data === undefined ? (
              <div className={styles.activityState}>
                <ErrorState error={timeline.error} retry={() => void timeline.refetch()} />
              </div>
            ) : items.length === 0 ? (
              <div className={styles.activityStateStack}>
                <DiagnosticsNotice diagnostics={diagnostics} hasTrustedItems={false} truncated={diagnosticsTruncated} />
                {sourceTruncated ? (
                  <div className={styles.activitySafetyNotice} role="status">
                    <History aria-hidden="true" />
                    <span><strong>The source scan reached a safety limit.</strong> No complete trusted result could be assembled from this scan.</span>
                  </div>
                ) : null}
                <StatePanel
                  compact
                  state="empty"
                  title={sourceTruncated
                    ? "No trusted rows available"
                    : source !== "all" || since
                      ? "No activity matches these filters"
                      : "No activity recorded"}
                  detail={sourceTruncated
                    ? "The source scan is incomplete, so this result cannot confirm that no matching activity exists."
                    : source !== "all" || since
                      ? "Clear or adjust the source and date filters to widen the timeline."
                      : "Canonical events and valid legacy rows will appear here when they exist."}
                />
              </div>
            ) : (
              <>
                <DiagnosticsNotice diagnostics={diagnostics} hasTrustedItems truncated={diagnosticsTruncated} />
                {sourceTruncated ? (
                  <div className={styles.activitySafetyNotice} role="status">
                    <History aria-hidden="true" />
                    <span><strong>The source scan reached a safety limit.</strong> This is a trustworthy partial timeline, not a complete history.</span>
                  </div>
                ) : null}
                <div className={styles.activityFeed}>
                  {groups.map(([day, dayItems]) => (
                    <section className={styles.activityDay} key={day} aria-labelledby={`activity-day-${day}`}>
                      <header className={styles.activityDayHeader}>
                        <h2 id={`activity-day-${day}`}>{formatDay(dayItems[0].timestamp)}</h2>
                        <span>{dayItems.length} {dayItems.length === 1 ? "event" : "events"}</span>
                      </header>
                      <ol className={styles.activityEntries} aria-label={`Activity for ${formatDay(dayItems[0].timestamp)}`}>
                        {dayItems.map((item) => (
                          <ActivityEntry
                            expanded={expanded.has(item.id)}
                            item={item}
                            key={`${item.source}:${item.id}`}
                            onToggle={() => setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })}
                          />
                        ))}
                      </ol>
                    </section>
                  ))}
                </div>

                <div className={styles.activityPagination}>
                  {paginationConflict ? (
                    <div className={styles.activityPaginationProblem} role="alert">
                      <RotateCcw aria-hidden="true" />
                      <span><strong>Activity changed while you were reading.</strong> Loaded rows were not mixed with the newer revision.</span>
                      <Button className={styles.paginationAction} onClick={reloadNewest} size="sm" type="button" variant="outline">Reload newest</Button>
                    </div>
                  ) : timeline.isFetchNextPageError ? (
                    <div className={styles.activityPaginationProblem} role="alert">
                      <AlertTriangle aria-hidden="true" />
                      <span><strong>Older activity could not be loaded.</strong> The events already on screen remain trustworthy.</span>
                      <Button className={styles.paginationAction} onClick={() => void timeline.fetchNextPage()} size="sm" type="button" variant="outline">Try again</Button>
                    </div>
                  ) : timeline.hasNextPage ? (
                    <Button className={styles.activityLoadMore} disabled={timeline.isFetchingNextPage} onClick={() => void timeline.fetchNextPage()} type="button">
                      {timeline.isFetchingNextPage ? "Loading older activity…" : "Load older activity"}
                    </Button>
                  ) : (
                    <p><CircleDot aria-hidden="true" /> {sourceTruncated ? "End of available history" : "End of trustworthy history"}</p>
                  )}
                </div>
              </>
            )}
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}
