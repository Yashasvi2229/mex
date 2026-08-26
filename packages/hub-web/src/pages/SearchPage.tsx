import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Braces,
  FileCode2,
  FileSearch,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "../api/types";
import { ErrorState, PageHeader, Panel, StatePanel, StatusPill } from "../components/ui";
import styles from "../styles/hub.module.css";

type GroupKind = keyof SearchResponse["groups"];
type ResultGroupData = SearchResponse["groups"][GroupKind];

interface ResultGroupView {
  kind: GroupKind;
  label: string;
  group: ResultGroupData;
}

const cursorField: Record<GroupKind, "wikiCursor" | "symbolCursor" | "sourceCursor"> = {
  wiki: "wikiCursor",
  symbols: "symbolCursor",
  sources: "sourceCursor",
};

function SymbolResult({ item }: { item: Extract<SearchResult, { kind: "code_symbol" }> }) {
  return (
    <Link className={styles.searchResult} to={item.route}>
      <span className={styles.resultIcon}><Braces aria-hidden="true" /></span>
      <span className={styles.resultBody}>
        <small>{item.symbolKind} · {item.language}</small>
        <strong>{item.name}</strong>
        <p className={styles.resultQualified}>{item.qualifiedName}</p>
        {item.signature ? <code className={styles.resultSignature}>{item.signature}</code> : null}
        <span className={styles.resultMetadata}>
          <span>{item.path}:{item.startLine}–{item.endLine}</span>
        </span>
      </span>
      <ArrowUpRight aria-hidden="true" />
    </Link>
  );
}

function SourceResult({ item }: { item: Extract<SearchResult, { kind: "source_chunk" }> }) {
  const body = (
    <>
      <span className={styles.resultIcon}><FileCode2 aria-hidden="true" /></span>
      <span className={styles.resultBody}>
        <small>Source · lines {item.startLine}–{item.endLine}</small>
        <strong>{item.path}</strong>
        <pre className={styles.sourcePreview}>{item.preview}</pre>
        <span className={styles.resultMetadata}>
          {item.matchedTerms.slice(0, 4).map((term) => <span className={styles.termChip} key={term}>{term}</span>)}
          {item.matchedTerms.length > 4 ? <span>+{item.matchedTerms.length - 4} terms</span> : null}
          {item.symbolIds.slice(0, 2).map((symbolId) => <span key={symbolId}>symbol {symbolId}</span>)}
          {item.symbolIds.length > 2 ? <span>+{item.symbolIds.length - 2} symbols</span> : null}
          {item.previewTruncated ? <span>Preview shortened</span> : null}
        </span>
      </span>
      {item.route ? <ArrowUpRight aria-hidden="true" /> : null}
    </>
  );
  return item.route
    ? <Link className={styles.searchResult} to={item.route}>{body}</Link>
    : <article className={styles.searchResult}>{body}</article>;
}

function WikiResult({ item }: { item: Extract<SearchResult, { kind: "wiki" }> }) {
  const body = (
    <>
      <span className={styles.resultIcon}><FileSearch aria-hidden="true" /></span>
      <span className={styles.resultBody}>
        <small>Knowledge</small>
        <strong>{item.title}</strong>
        {item.description ? <p>{item.description}</p> : null}
        {item.path ? <span className={styles.resultMetadata}><span>{item.path}</span></span> : null}
      </span>
      {item.route ? <ArrowUpRight aria-hidden="true" /> : null}
    </>
  );
  return item.route
    ? <Link className={styles.searchResult} to={item.route}>{body}</Link>
    : <article className={styles.searchResult}>{body}</article>;
}

function Result({ item }: { item: SearchResult }) {
  if (item.kind === "code_symbol") return <SymbolResult item={item} />;
  if (item.kind === "source_chunk") return <SourceResult item={item} />;
  return <WikiResult item={item} />;
}

function ResultGroup({
  view,
  query,
  onReload,
}: {
  view: ResultGroupView;
  query: string;
  onReload: () => void;
}) {
  const api = useHubApi();
  const [group, setGroup] = useState(view.group);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const pagination = useMutation({
    mutationFn: async () => {
      if (group.status !== "available" || !group.nextCursor) return null;
      const request: SearchRequest = {
        q: query,
        limit: 25,
        [cursorField[view.kind]]: group.nextCursor,
      };
      return (await api.search(request)).groups[view.kind];
    },
    onSuccess: (next) => {
      if (!next || group.status !== "available") return;
      if (next.status !== "available") {
        if (next.code === "REVISION_CONFLICT") setRevisionConflict(true);
        else setPageFailed(true);
        return;
      }
      if (next.revision !== group.revision) {
        setRevisionConflict(true);
        return;
      }
      setGroup({
        ...next,
        items: [...group.items, ...next.items.filter((item) => !group.items.some((loaded) => loaded.id === item.id))],
      });
    },
    onError: (error) => {
      if (error instanceof HubApiError && error.problem.code === "REVISION_CONFLICT") {
        setRevisionConflict(true);
      }
    },
  });

  function loadMore() {
    setPageFailed(false);
    pagination.mutate();
  }

  useEffect(() => {
    setGroup(view.group);
    setRevisionConflict(false);
    setPageFailed(false);
    pagination.reset();
  }, [view.group]);

  return (
    <Panel className={styles.searchGroup} aria-labelledby={`group-${view.kind}`}>
      <div className={styles.searchGroupHeader}>
        <div><p className={styles.panelEyebrow}>{view.kind}</p><h2 id={`group-${view.kind}`}>{view.label}</h2></div>
        <StatusPill tone={group.status === "available" ? "neutral" : group.status === "failed" ? "danger" : "warning"}>
          {group.status === "available" ? `${group.items.length} loaded` : group.status}
        </StatusPill>
      </div>
      {group.status === "failed" ? (
        <div className={styles.groupProblem} role="status"><AlertTriangle aria-hidden="true" /><p><strong>This source failed independently.</strong>{group.detail}</p></div>
      ) : group.status === "unavailable" ? (
        <StatePanel compact state="unavailable" title={`${view.label} unavailable`} detail={group.detail ?? "This capability is not connected in the current build."} />
      ) : group.items.length ? (
        <div className={styles.searchResults}>{group.items.map((item) => <Result item={item} key={item.id} />)}</div>
      ) : (
        <StatePanel compact state="empty" title={`No ${view.label.toLowerCase()} found`} detail="This source completed successfully but returned no results." />
      )}

      {revisionConflict ? (
        <div className={styles.groupPaginationProblem} role="alert">
          <RefreshCw aria-hidden="true" />
          <span><strong>This source changed while you were paging.</strong>Reload the newest graph snapshot before loading more results.</span>
          <button className={styles.secondaryButton} onClick={onReload} type="button">Reload results</button>
        </div>
      ) : pagination.isError || pageFailed ? (
        <div className={styles.groupPaginationProblem} role="alert">
          <AlertTriangle aria-hidden="true" />
          <span><strong>More {view.label.toLowerCase()} could not be loaded.</strong>The results already on screen are unchanged.</span>
          <button className={styles.secondaryButton} onClick={loadMore} type="button">Try again</button>
        </div>
      ) : group.status === "available" && group.nextCursor ? (
        <button className={styles.loadMore} disabled={pagination.isPending} onClick={loadMore} type="button">
          {pagination.isPending ? "Loading…" : `Load more ${view.label.toLowerCase()}`}
        </button>
      ) : group.status === "available" && group.truncated ? (
        <p className={styles.truncatedNote}>This source reached its safety bound. Refine the query to narrow the result.</p>
      ) : null}
    </Panel>
  );
}

function SearchWorkbench({ scope }: { scope: "project" | "code" }) {
  const api = useHubApi();
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").slice(0, 256);
  const [draft, setDraft] = useState(query);
  const summaryRef = useRef<HTMLDivElement>(null);
  const search = useQuery({
    queryKey: ["search", query],
    queryFn: () => api.search({ q: query, limit: 25 }),
    enabled: query.trim().length > 0,
    retry: false,
  });

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    if (search.data) summaryRef.current?.focus({ preventScroll: true });
  }, [search.data]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim().slice(0, 256);
    setParams(next ? { q: next } : {}, { replace: false });
  }

  function clear() {
    setDraft("");
    setParams({}, { replace: false });
  }

  const groups: ResultGroupView[] = search.data ? [
    ...(scope === "project" ? [{ kind: "wiki" as const, label: "Knowledge", group: search.data.groups.wiki }] : []),
    { kind: "symbols", label: "Code symbols", group: search.data.groups.symbols },
    { kind: "sources", label: "Source matches", group: search.data.groups.sources },
  ] : [];

  return (
    <>
      <form className={styles.searchForm} role="search" onSubmit={submit}>
        <Search aria-hidden="true" />
        <label className={styles.srOnly} htmlFor={`${scope}-search`}>{scope === "project" ? "Search project memory and code" : "Search code symbols and source"}</label>
        <input autoComplete="off" id={`${scope}-search`} maxLength={256} onChange={(event) => setDraft(event.target.value)} placeholder={scope === "project" ? "Search knowledge, symbols, or source…" : "Search symbols, signatures, paths, or source…"} type="search" value={draft} />
        <span className={styles.queryCount}>{draft.length}/256</span>
        {draft ? <button aria-label="Clear search" className={styles.iconButton} onClick={clear} type="button"><X /></button> : null}
        <button className={styles.primaryButton} disabled={!draft.trim()} type="submit">Search</button>
      </form>

      {!query ? (
        <div className={`${styles.searchWelcome} ${scope === "code" ? styles.codeSearchWelcome : ""}`}>
          <span>{scope === "code" ? <Braces aria-hidden="true" /> : <Search aria-hidden="true" />}</span>
          <h2>{scope === "code" ? "Find the exact symbol behind the change" : "One query, clearly separated sources"}</h2>
          <p>{scope === "code" ? "Search the local graph by symbol, signature, repository path, or source term. Open a symbol to inspect its bounded source and semantic relationships." : "Enter a file, symbol, decision, topic, or exact phrase. Unavailable sources will be identified instead of silently omitted."}</p>
          <div>{scope === "project" ? <span>Knowledge</span> : null}<span>Code symbols</span><span>Source matches</span></div>
        </div>
      ) : search.isPending ? (
        <StatePanel state="loading" title={`Searching for “${query}”`} detail="Available local sources are being queried independently." />
      ) : search.isError ? (
        <ErrorState error={search.error} retry={() => void search.refetch()} />
      ) : (
        <>
          <div className={styles.resultsSummary} aria-live="polite" ref={summaryRef} tabIndex={-1}><span>Results for</span><strong>“{search.data.query}”</strong><span>{groups.length} independent source groups</span></div>
          <div className={`${styles.searchGrid} ${scope === "code" ? styles.codeSearchGrid : ""}`}>
            {groups.map((view) => <ResultGroup key={`${query}-${view.kind}`} onReload={() => void search.refetch()} query={query} view={view} />)}
          </div>
        </>
      )}
    </>
  );
}

export function SearchPage() {
  return (
    <div className={styles.page}>
      <PageHeader eyebrow="Grouped retrieval" title="Search the project" description="Query each available source independently. Results stay grouped so scores from different indexes are never presented as directly comparable." />
      <SearchWorkbench scope="project" />
    </div>
  );
}

export function CodePage() {
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const unavailable = capabilities?.graph.read.availability === "unavailable";
  return (
    <div className={styles.page}>
      <PageHeader eyebrow="Repository observatory" title="Explore the code graph" description="Inspect exact indexed source and bounded semantic relationships. This workbench never refreshes or rebuilds the graph during a read." />
      {!capabilities ? (
        <StatePanel state="loading" title="Checking graph availability" detail="Reading the process-local capability boundary before querying the graph." />
      ) : unavailable ? (
        <StatePanel state="unavailable" title="Code graph unavailable" detail={capabilities.graph.read.reason ?? "The code graph is not connected in this build."} />
      ) : <SearchWorkbench scope="code" />}
    </div>
  );
}
