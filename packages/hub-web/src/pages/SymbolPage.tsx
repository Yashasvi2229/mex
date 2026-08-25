import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Braces,
  ChevronRight,
  FileCode2,
  Network,
  RefreshCw,
  Route,
} from "lucide-react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  CodeWorkspaceRequest,
  CodeWorkspaceResponse,
  CodeWorkspaceView,
  GraphRelation,
  GraphSourceProjection,
  GraphSymbol,
} from "../api/types";
import { ErrorState, StatePanel, StatusPill, sentenceCase } from "../components/ui";
import { Badge } from "../components/primitives/badge";
import { Button, buttonVariants } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/primitives/tabs";
import { cn } from "../lib/utils";
import styles from "../styles/symbol.module.css";

const workspaceViews: Array<{ value: CodeWorkspaceView; label: string; icon: typeof Braces }> = [
  { value: "overview", label: "Overview", icon: Braces },
  { value: "callers", label: "Callers", icon: ArrowLeft },
  { value: "callees", label: "Callees", icon: ArrowRight },
  { value: "impact", label: "Impact", icon: Network },
];

function viewFrom(value: string | null): CodeWorkspaceView {
  return workspaceViews.some((item) => item.value === value) ? value as CodeWorkspaceView : "overview";
}

function depthFrom(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : 2;
}

function SymbolLink({ symbol, compact = false }: { symbol: GraphSymbol; compact?: boolean }) {
  return (
    <Item
      className={cn(styles.symbolLink, compact && styles.symbolLinkCompact)}
      render={<Link to={symbol.route} />}
      size="xs"
    >
      <ItemContent>
        <ItemTitle>{symbol.name}</ItemTitle>
        <ItemDescription>{symbol.qualifiedName}</ItemDescription>
      </ItemContent>
      <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
    </Item>
  );
}

function SourceSpecimen({ source }: { source: GraphSourceProjection }) {
  const lines = useMemo(() => {
    const split = source.content.split("\n");
    return source.content.endsWith("\n") ? split.slice(0, -1) : split;
  }, [source.content]);
  return (
    <article className={styles.sourceSpecimen}>
      <header>
        <span><FileCode2 aria-hidden="true" /><strong>{source.path}</strong></span>
        <span className={styles.mono}>sha256:{source.contentHash.slice(0, 12)}</span>
      </header>
      <div aria-label={`${source.path}, lines ${source.startLine} through ${source.endLine}`} className={styles.sourceCode} role="region" tabIndex={0}>
        {lines.map((line, index) => (
          <div className={styles.sourceLine} key={`${source.startLine + index}-${index}`}>
            <span aria-hidden="true">{source.startLine + index}</span>
            <code>{line}</code>
          </div>
        ))}
      </div>
    </article>
  );
}

function RelationRow({ relation, symbolId, view }: { relation: GraphRelation; symbolId: string; view: "callers" | "callees" }) {
  const relatedId = view === "callers" ? relation.sourceId : relation.targetId;
  return (
    <Item
      className={styles.relationRow}
      render={<Link to={`/code/symbols/${encodeURIComponent(relatedId)}?view=${view}`} />}
      size="sm"
    >
      <ItemMedia className={styles.relationGlyph} variant="icon"><Route aria-hidden="true" /></ItemMedia>
      <ItemContent className={styles.relationContent}>
        <small>{sentenceCase(relation.kind)} · {view === "callers" ? "incoming" : "outgoing"}</small>
        <strong className={styles.mono}>{relatedId === symbolId ? "Current symbol" : relatedId}</strong>
        {relation.path ? <span className={styles.mono}>{relation.path}{relation.line ? `:${relation.line}` : ""}</span> : null}
      </ItemContent>
      <ItemActions className={styles.relationEvidence}>
        {relation.confidence !== undefined ? <Badge variant="outline">{Math.round(relation.confidence * 100)}% confidence</Badge> : null}
        {relation.provenance ? <Badge variant="secondary">{relation.provenance}</Badge> : null}
        <ChevronRight aria-hidden="true" />
      </ItemActions>
    </Item>
  );
}

function OverviewTraversal({ symbol }: { symbol: GraphSymbol }) {
  return (
    <div className={styles.traversalOverview}>
      <ItemGroup aria-label="Symbol graph views" className={styles.lensList} role="navigation">
        <Item render={<Link to={`${symbol.route}?view=callers`} />} size="sm">
          <ItemMedia variant="icon"><ArrowLeft aria-hidden="true" /></ItemMedia>
          <ItemContent><ItemTitle>Callers</ItemTitle><ItemDescription>Inbound references</ItemDescription></ItemContent>
          <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
        </Item>
        <Item render={<Link to={`${symbol.route}?view=callees`} />} size="sm">
          <ItemMedia variant="icon"><ArrowRight aria-hidden="true" /></ItemMedia>
          <ItemContent><ItemTitle>Callees</ItemTitle><ItemDescription>Outbound references</ItemDescription></ItemContent>
          <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
        </Item>
        <Item render={<Link to={`${symbol.route}?view=impact&depth=2`} />} size="sm">
          <ItemMedia variant="icon"><Network aria-hidden="true" /></ItemMedia>
          <ItemContent><ItemTitle>Impact</ItemTitle><ItemDescription>Bounded dependents</ItemDescription></ItemContent>
          <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
        </Item>
      </ItemGroup>
    </div>
  );
}

function TraversalPanel({
  response,
  relations,
  onLoadMore,
  loadingMore,
  paginationError,
  hasMore,
  relationTruncated,
}: {
  response: CodeWorkspaceResponse;
  relations: GraphRelation[];
  onLoadMore: () => void;
  loadingMore: boolean;
  paginationError: boolean;
  hasMore: boolean;
  relationTruncated: boolean;
}) {
  const traversal = response.traversal;
  if (traversal.view === "overview") return <OverviewTraversal symbol={response.symbol} />;
  if (traversal.view === "impact") {
    return (
      <div className={styles.impactView}>
        <div className={styles.impactSummary}>
          <span><strong>{traversal.impacted.length}</strong> affected dependents</span>
          <span><strong>{traversal.roots.length}</strong> roots</span>
          <span><strong>{traversal.relations.length}</strong> relations</span>
        </div>
        {traversal.roots.length ? (
          <section className={styles.impactSection} aria-labelledby="impact-roots">
            <h2 id="impact-roots">Impact roots</h2>
            <div>{traversal.roots.map((symbol) => <SymbolLink compact key={symbol.id} symbol={symbol} />)}</div>
          </section>
        ) : null}
        <section className={styles.impactSection} aria-labelledby="impact-symbols">
          <h2 id="impact-symbols">Dependent blast radius</h2>
          {traversal.impacted.length ? (
            <div>{traversal.impacted.map((item) => (
              <div className={styles.impactRow} key={`${item.symbol.id}-${item.rootId}`}>
                <SymbolLink compact symbol={item.symbol} />
                <span>Depth {item.depth} · root <code>{item.rootId}</code></span>
              </div>
            ))}</div>
          ) : <StatePanel compact state="empty" title="No dependent impact found" detail="The bounded traversal completed without affected dependents." />}
        </section>
        {traversal.truncated ? <p className={styles.truncatedNote}>Impact reached the configured depth or node safety limit.</p> : null}
      </div>
    );
  }

  return (
    <div className={styles.relationList}>
      {relations.length ? relations.map((relation, index) => (
        <RelationRow key={`${relation.sourceId}-${relation.targetId}-${relation.kind}-${index}`} relation={relation} symbolId={response.symbol.id} view={traversal.view} />
      )) : <StatePanel compact state="empty" title={`No ${traversal.view} found`} detail={`The graph returned no ${traversal.view} for this symbol.`} />}
      {paginationError ? (
        <div className={styles.inlinePaginationProblem} role="alert">
          <AlertTriangle aria-hidden="true" />
          <span><strong>More relationships could not be loaded.</strong>Loaded relationships remain visible.</span>
          <Button onClick={onLoadMore} size="sm" type="button" variant="outline">Try again</Button>
        </div>
      ) : hasMore ? (
        <Button className={styles.loadMore} disabled={loadingMore} onClick={onLoadMore} type="button" variant="outline">{loadingMore ? "Loading…" : `Load more ${traversal.view}`}</Button>
      ) : relationTruncated ? <p className={styles.truncatedNote}>This traversal reached its safety bound.</p> : null}
    </div>
  );
}

function SymbolIdentity({ response }: { response: CodeWorkspaceResponse }) {
  const { symbol } = response;
  return (
    <section className={styles.symbolIdentity} aria-labelledby="symbol-identity-heading">
      <Card className={styles.workspaceCard} size="sm">
        <CardHeader>
          <Badge variant="secondary">{symbol.language} · {symbol.symbolKind}</Badge>
          <CardTitle><h2 id="symbol-identity-heading">{symbol.name}</h2></CardTitle>
          <CardDescription><p className={styles.symbolQualified}>{symbol.qualifiedName}</p></CardDescription>
        </CardHeader>
        <CardContent>
          {symbol.signature ? <code className={styles.symbolSignature}>{symbol.signature}</code> : null}
          <dl className={styles.symbolFacts}>
            <div><dt>File</dt><dd className={styles.mono}>{symbol.path}</dd></div>
            <div><dt>Range</dt><dd className={styles.mono}>{symbol.startLine}–{symbol.endLine}</dd></div>
            <div><dt>Symbol ID</dt><dd className={styles.mono}>{symbol.id}</dd></div>
            <div><dt>Revision</dt><dd className={styles.mono}>{response.revision.slice(0, 12)}</dd></div>
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}

function GraphProblem({ error, retry }: { error: unknown; retry: () => void }) {
  const problem = error instanceof HubApiError ? error.problem : null;
  if (problem && ["INDEX_MISSING", "INDEX_STALE", "INDEX_CORRUPT", "MIGRATION_REQUIRED"].includes(problem.code)) {
    return (
      <StatePanel
        action={<Link className={buttonVariants({ size: "sm", variant: "outline" })} to="/health">Open Graph health</Link>}
        detail="The symbol workbench only reads a trustworthy graph snapshot. Inspect Health, then explicitly refresh or rebuild if the repository needs it."
        state="unavailable"
        title={problem.code === "INDEX_STALE" ? "The graph snapshot is stale" : "A trustworthy graph snapshot is unavailable"}
      />
    );
  }
  return <ErrorState error={error} retry={retry} />;
}

export function SymbolPage() {
  const api = useHubApi();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const view = viewFrom(params.get("view"));
  const depth = depthFrom(params.get("depth"));
  const workspaceRef = useRef<HTMLElement>(null);
  const focusedSymbolId = useRef<string | null>(null);
  const [displayed, setDisplayed] = useState<CodeWorkspaceResponse | null>(null);
  const [sources, setSources] = useState<GraphSourceProjection[]>([]);
  const [relations, setRelations] = useState<GraphRelation[]>([]);
  const [sourceCursor, setSourceCursor] = useState<string | null>(null);
  const [relationCursor, setRelationCursor] = useState<string | null>(null);
  const [sourceTruncated, setSourceTruncated] = useState(false);
  const [relationTruncated, setRelationTruncated] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const checkingCapability = capabilities === undefined;
  const unavailable = capabilities?.graph.read.availability === "unavailable";
  const request: CodeWorkspaceRequest = {
    view,
    ...(view === "callers" || view === "callees" ? { limit: 25 } : {}),
    ...(view === "impact" ? { depth } : {}),
  };
  const workspace = useQuery({
    queryKey: ["code-symbol", id, view, view === "impact" ? depth : null],
    queryFn: () => api.getCodeSymbol(id, request),
    enabled: capabilities?.graph.read.availability === "available",
    retry: false,
  });

  const loadSource = useMutation({
    mutationFn: () => api.getCodeSymbol(id, { ...request, sourceCursor: sourceCursor ?? undefined }),
    onSuccess: (next) => {
      if (!workspace.data || next.view !== view || next.revision !== workspace.data.revision) {
        setRevisionConflict(true);
        return;
      }
      setSources((current) => [...current, ...next.source.items.filter((item) => !current.some((loaded) => loaded.contentHash === item.contentHash && loaded.startLine === item.startLine))]);
      setSourceCursor(next.source.nextCursor);
      setSourceTruncated(next.source.truncated);
    },
    onError: (error) => {
      if (error instanceof HubApiError && error.problem.code === "REVISION_CONFLICT") setRevisionConflict(true);
    },
  });

  const loadRelations = useMutation({
    mutationFn: () => api.getCodeSymbol(id, { ...request, cursor: relationCursor ?? undefined }),
    onSuccess: (next) => {
      if (!workspace.data || next.view !== view || next.revision !== workspace.data.revision) {
        setRevisionConflict(true);
        return;
      }
      const traversal = next.traversal;
      if (traversal.view !== "callers" && traversal.view !== "callees") return;
      setRelations((current) => [...current, ...traversal.items]);
      setRelationCursor(traversal.nextCursor);
      setRelationTruncated(traversal.truncated);
    },
    onError: (error) => {
      if (error instanceof HubApiError && error.problem.code === "REVISION_CONFLICT") setRevisionConflict(true);
    },
  });

  function commitRootResponse(next: CodeWorkspaceResponse) {
    setDisplayed(next);
    setSources(next.source.items);
    setSourceCursor(next.source.nextCursor);
    setSourceTruncated(next.source.truncated);
    const traversal = next.traversal;
    setRelations(traversal.view === "callers" || traversal.view === "callees" ? traversal.items : []);
    setRelationCursor(traversal.view === "callers" || traversal.view === "callees" ? traversal.nextCursor : null);
    setRelationTruncated(traversal.view === "callers" || traversal.view === "callees" ? traversal.truncated : false);
    loadSource.reset();
    loadRelations.reset();
    setRevisionConflict(false);
  }

  useEffect(() => {
    if (workspace.data) commitRootResponse(workspace.data);
  }, [id, workspace.data]);

  const response = displayed?.symbol.id === id ? displayed : null;

  useEffect(() => {
    const symbolId = response?.symbol.id;
    if (!symbolId || focusedSymbolId.current === symbolId) return;
    focusedSymbolId.current = symbolId;
    workspaceRef.current?.focus({ preventScroll: true });
  }, [response?.symbol.id]);

  function selectView(next: CodeWorkspaceView) {
    setParams(next === "overview" ? {} : next === "impact" ? { view: next, depth: String(depth) } : { view: next });
  }

  async function reloadNewest() {
    const result = await workspace.refetch();
    if (result.isSuccess) commitRootResponse(result.data);
  }

  return (
    <div className={styles.page}>
      <Link className={cn(buttonVariants({ size: "sm", variant: "ghost" }), styles.symbolBackLink)} to="/code">
        <ArrowLeft aria-hidden="true" data-icon="inline-start" />
        Back to code search
      </Link>
      {checkingCapability ? (
        <StatePanel state="loading" title="Checking graph availability" detail="The symbol read will start only after the local capability boundary is known." />
      ) : unavailable ? (
        <StatePanel state="unavailable" title="Code graph unavailable" detail={capabilities.graph.read.reason ?? "The code graph is not connected in this build."} />
      ) : workspace.isPending && !response ? (
        <StatePanel state="loading" title="Opening symbol workspace" detail="Reading one bounded, revision-consistent graph snapshot." />
      ) : workspace.isError && !response ? (
        <GraphProblem error={workspace.error} retry={() => void workspace.refetch()} />
      ) : response ? (
        <>
          <header className={styles.symbolHeader} ref={workspaceRef} tabIndex={-1}>
            <div><h1>{response.symbol.name}</h1><p>{response.symbol.qualifiedName}</p></div>
            <StatusPill>Revision {response.revision.slice(0, 8)}</StatusPill>
          </header>
          <Tabs className={styles.workspaceTabs} onValueChange={(next) => selectView(viewFrom(next))} value={view}>
            <div className={styles.symbolTabs}>
              <TabsList activateOnFocus aria-label="Inspect symbol graph" className={styles.symbolTabList} variant="line">
                {workspaceViews.map((item) => (
                  <TabsTrigger id={`symbol-tab-${item.value}`} key={item.value} value={item.value}>
                    <item.icon aria-hidden="true" data-icon="inline-start" />
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {view === "impact" ? (
                <label>Depth<select aria-label="Impact depth" onChange={(event) => setParams({ view: "impact", depth: event.target.value })} value={depth}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              ) : null}
            </div>
            {revisionConflict ? (
              <div className={styles.graphRevisionConflict} role="alert">
                <RefreshCw aria-hidden="true" />
                <span>
                  <strong>The graph changed while you were reading.</strong>
                  Loaded source and relationships remain visible, but pages from different revisions will not be combined.
                  {workspace.isError ? <small>The newest graph could not be reloaded. This revision remains frozen.</small> : null}
                </span>
                <Button disabled={workspace.isFetching} onClick={() => void reloadNewest()} size="sm" type="button" variant="outline">
                  {workspace.isFetching ? "Reloading…" : "Reload newest graph"}
                </Button>
              </div>
            ) : null}
            <div className={styles.symbolWorkspace}>
              <SymbolIdentity response={response} />
              <section className={styles.sourceWorkspace} aria-labelledby="source-heading">
                <Card className={styles.workspaceCard} size="sm">
                  <CardHeader>
                    <CardTitle><h2 id="source-heading">Source specimen</h2></CardTitle>
                    <CardAction><Badge variant="secondary">{sources.length} chunk{sources.length === 1 ? "" : "s"}</Badge></CardAction>
                  </CardHeader>
                  <CardContent className={styles.sourceCardContent}>
                    {sources.length ? <div className={styles.sourceSpecimens}>{sources.map((source) => <SourceSpecimen key={`${source.contentHash}-${source.startLine}`} source={source} />)}</div> : <StatePanel compact state="empty" title="No source projection available" detail="The symbol exists in the graph, but no bounded source body was returned." />}
                    {loadSource.isError && !revisionConflict ? (
                      <div className={styles.inlinePaginationProblem} role="alert"><AlertTriangle aria-hidden="true" /><span><strong>More source could not be loaded.</strong>Loaded source remains unchanged.</span><Button onClick={() => loadSource.mutate()} size="sm" type="button" variant="outline">Try again</Button></div>
                    ) : sourceCursor && !revisionConflict && !workspace.isPending && !workspace.isError ? <Button className={styles.loadMore} disabled={loadSource.isPending} onClick={() => loadSource.mutate()} type="button" variant="outline">{loadSource.isPending ? "Loading…" : "Load more source"}</Button> : sourceTruncated ? <p className={styles.truncatedNote}>Source reached its bounded response limit.</p> : null}
                  </CardContent>
                </Card>
              </section>
              {workspaceViews.map((item) => (
                <TabsContent className={styles.traversalWorkspace} key={item.value} value={item.value}>
                  {view === item.value ? (
                    <Card className={styles.workspaceCard} size="sm">
                      <CardHeader><CardTitle><h2>{view === "impact" ? "Dependent impact" : sentenceCase(view)}</h2></CardTitle></CardHeader>
                      <CardContent className={styles.traversalCardContent}>
                        {workspace.isPending || response.view !== view ? (
                          <StatePanel compact state="loading" title={`Loading ${view}`} detail="Reading this traversal from one coherent graph revision." />
                        ) : workspace.isError && !revisionConflict ? (
                          <GraphProblem error={workspace.error} retry={() => void workspace.refetch()} />
                        ) : (
                          <TraversalPanel hasMore={relationCursor !== null && !revisionConflict} loadingMore={loadRelations.isPending} onLoadMore={() => loadRelations.mutate()} paginationError={loadRelations.isError && !revisionConflict} relationTruncated={relationTruncated} relations={relations} response={response} />
                        )}
                      </CardContent>
                    </Card>
                  ) : null}
                </TabsContent>
              ))}
            </div>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}
