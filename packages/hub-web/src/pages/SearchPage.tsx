import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, FileSearch, Search, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useHubApi } from "../api/context";
import type { SearchResponse } from "../api/types";
import { ErrorState, PageHeader, Panel, StatePanel, StatusPill } from "../components/ui";
import styles from "../styles/hub.module.css";

type ResultItem = SearchResponse["groups"]["wiki"]["items"][number];
type ResultGroupData = SearchResponse["groups"]["wiki"];

interface ResultGroupView {
  kind: keyof SearchResponse["groups"];
  label: string;
  group: ResultGroupData;
}

function Result({ item }: { item: ResultItem }) {
  const body = (
    <>
      <span className={styles.resultIcon}><FileSearch aria-hidden="true" /></span>
      <span className={styles.resultBody}>
        <small>{item.kind.replaceAll("_", " ")}</small>
        <strong>{item.title}</strong>
        {item.description ? <p>{item.description}</p> : null}
        {item.path ? <span className={styles.resultMetadata}><span>{item.path}</span></span> : null}
      </span>
      {item.route ? <ArrowUpRight aria-hidden="true" /> : null}
    </>
  );
  return item.route ? <Link className={styles.searchResult} to={item.route}>{body}</Link> : <article className={styles.searchResult}>{body}</article>;
}

function ResultGroup({ view }: { view: ResultGroupView }) {
  const { group } = view;
  return (
    <Panel className={styles.searchGroup} aria-labelledby={`group-${view.kind}`}>
      <div className={styles.searchGroupHeader}>
        <div><p className={styles.panelEyebrow}>{view.kind}</p><h2 id={`group-${view.kind}`}>{view.label}</h2></div>
        <StatusPill tone={group.status === "available" ? "neutral" : group.status === "failed" ? "danger" : "warning"}>
          {group.status === "available" ? `${group.items.length} result${group.items.length === 1 ? "" : "s"}` : group.status}
        </StatusPill>
      </div>
      {group.status === "failed" ? (
        <div className={styles.groupProblem} role="status"><AlertTriangle aria-hidden="true" /><p><strong>This source failed independently.</strong>{group.detail}</p></div>
      ) : group.status === "unavailable" ? (
        <StatePanel compact state="unavailable" title={`${view.label} unavailable`} detail={group.detail ?? "This capability is not connected in the current build."} />
      ) : group.items.length ? (
        <div className={styles.searchResults}>{group.items.map((item) => <Result item={item} key={item.id} />)}</div>
      ) : (
        <StatePanel compact state="empty" title={`No ${view.label.toLowerCase()} matches`} detail="This source completed successfully but returned no results." />
      )}
      {group.truncated ? <p className={styles.truncatedNote}>More results exist in this source. Refine the query to narrow the set.</p> : null}
    </Panel>
  );
}

export function SearchPage() {
  const api = useHubApi();
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").slice(0, 256);
  const [draft, setDraft] = useState(query);
  const search = useQuery({ queryKey: ["search", query], queryFn: () => api.search(query), enabled: query.trim().length > 0, retry: false });

  useEffect(() => {
    setDraft(query);
  }, [query]);

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
    { kind: "wiki", label: "Knowledge", group: search.data.groups.wiki },
    { kind: "symbols", label: "Code symbols", group: search.data.groups.symbols },
    { kind: "sources", label: "Source chunks", group: search.data.groups.sources },
  ] : [];

  return (
    <div className={styles.page}>
      <PageHeader eyebrow="Grouped retrieval" title="Search the project" description="Query each available source independently. Results stay grouped so scores from different indexes are never presented as directly comparable." />
      <form className={styles.searchForm} role="search" onSubmit={submit}>
        <Search aria-hidden="true" />
        <label className={styles.srOnly} htmlFor="project-search">Search project memory and code</label>
        <input autoComplete="off" id="project-search" maxLength={256} onChange={(event) => setDraft(event.target.value)} placeholder="Search knowledge, symbols, or source…" type="search" value={draft} />
        <span className={styles.queryCount}>{draft.length}/256</span>
        {draft ? <button aria-label="Clear search" className={styles.iconButton} onClick={clear} type="button"><X /></button> : null}
        <button className={styles.primaryButton} disabled={!draft.trim()} type="submit">Search</button>
      </form>

      {!query ? (
        <div className={styles.searchWelcome}>
          <span><Search aria-hidden="true" /></span>
          <h2>One query, clearly separated sources</h2>
          <p>Enter a file, symbol, decision, topic, or exact phrase. Unavailable sources will be identified instead of silently omitted.</p>
          <div><span>Knowledge</span><span>Code symbols</span><span>Source chunks</span></div>
        </div>
      ) : search.isPending ? (
        <StatePanel state="loading" title={`Searching for “${query}”`} detail="Available local sources are being queried independently." />
      ) : search.isError ? (
        <ErrorState error={search.error} retry={() => void search.refetch()} />
      ) : (
        <>
          <div className={styles.resultsSummary} aria-live="polite"><span>Results for</span><strong>“{search.data.query}”</strong><span>{groups.length} source groups</span></div>
          <div className={styles.searchGrid}>{groups.map((view) => <ResultGroup key={view.kind} view={view} />)}</div>
        </>
      )}
    </div>
  );
}
