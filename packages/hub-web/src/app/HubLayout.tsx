import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2, GitBranch, GitCommitHorizontal, Menu, X } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import type { CapabilitiesResponse, HomeResponse, OverviewResponse, SessionResponse } from "../api/types";
import { useHubApi } from "../api/context";
import { formatTime, StatePanel, StatusPill } from "../components/ui";
import styles from "../styles/shell.module.css";
import { JobLifecycleObserver } from "./JobLifecycleObserver";
import { HubSidebar } from "./HubSidebar";

export interface HubOutletContext {
  capabilities?: CapabilitiesResponse;
  clearSearchFocusRequest: () => void;
  home?: HomeResponse;
  searchFocusRequest: number;
}

function contentEditable(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const value = current.getAttribute("contenteditable");
    if (value !== null) return value.toLowerCase() !== "false";
    current = current.parentElement;
  }
  return false;
}

export function shouldHandleSearchShortcut(event: KeyboardEvent): boolean {
  if (
    event.key !== "/"
    || event.defaultPrevented
    || event.ctrlKey
    || event.metaKey
    || event.altKey
  ) return false;

  const target = event.target;
  const eventDocument = target instanceof Element ? target.ownerDocument : document;
  if (eventDocument.querySelector(
    '[role="dialog"]:not([hidden]):not([aria-hidden="true"]), [role="alertdialog"]:not([hidden]):not([aria-hidden="true"])',
  )) return false;
  if (!(target instanceof Element)) return true;
  return !target.closest("input, textarea, select") && !contentEditable(target);
}

function RepositoryBar({ repository, session }: { repository?: HomeResponse["repository"]; session: SessionResponse }) {
  const context = repository;
  return (
    <header className={styles.contextBar} aria-label="Repository context">
      <div className={styles.repoIdentity}>
        <span className={styles.repoGlyph} aria-hidden="true"><FolderGit2 /></span>
        <span><strong>{context?.name ?? "Current project"}</strong></span>
      </div>
      <div className={styles.repoFacts}>
        {context?.branch ? (
          <span><GitBranch aria-hidden="true" /> <span>{context.branch}</span></span>
        ) : null}
        {context?.head ? (
          <span className={styles.mono}><GitCommitHorizontal aria-hidden="true" /> {context.head.slice(0, 8)}</span>
        ) : null}
        {typeof context?.dirty === "boolean" ? (
          <StatusPill tone={context.dirty ? "warning" : "success"}>
            {context.dirty ? "Local changes" : "Clean tree"}
          </StatusPill>
        ) : null}
      </div>
      <div className={styles.sessionMeta}>
        <span><small>Session</small><strong>{formatTime(session.expiresAt)}</strong></span>
      </div>
    </header>
  );
}

export function HubLayout({
  session,
  capabilities,
}: {
  session: SessionResponse;
  capabilities?: CapabilitiesResponse;
}) {
  const api = useHubApi();
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);
  const skipNextMainFocus = useRef(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const clearSearchFocusRequest = useCallback(() => setSearchFocusRequest(0), []);
  const isOverview = location.pathname === "/";
  const shell = useQuery<HomeResponse | OverviewResponse>({
    queryKey: [isOverview ? "overview" : "home"],
    queryFn: () => isOverview ? api.getOverview() : api.getHome(),
    retry: false,
  });
  const trustedHome = shell.isSuccess
    ? isOverview
      ? (shell.data as OverviewResponse).shell
      : shell.data as HomeResponse
    : undefined;

  useEffect(() => {
    if (previousPath.current !== location.pathname) {
      const focusSearch = skipNextMainFocus.current && location.pathname === "/search";
      skipNextMainFocus.current = false;
      if (!focusSearch) mainRef.current?.focus({ preventScroll: true });
      previousPath.current = location.pathname;
    }
  }, [location.pathname]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!shouldHandleSearchShortcut(event)) return;
      event.preventDefault();
      skipNextMainFocus.current = location.pathname !== "/search";
      setSearchFocusRequest((current) => current + 1);
      if (location.pathname !== "/search") navigate("/search");
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [location.pathname, navigate]);

  return (
    <div className={styles.viewportFrame}>
      {isOverview ? null : <JobLifecycleObserver channelScope={session.expiresAt} />}
      <a className={styles.skipLink} href="#main-content">Skip to main content</a>
      <HubSidebar capabilities={capabilities} home={trustedHome} />
      <div className={styles.workspace}>
        <RepositoryBar repository={trustedHome?.repository} session={session} />
        <main id="main-content" className={styles.main} ref={mainRef} tabIndex={-1}>
          <Suspense fallback={<StatePanel state="loading" title="Opening workbench" detail="Loading this local Hub view." />}>
            <Outlet context={{ capabilities, clearSearchFocusRequest, home: trustedHome, searchFocusRequest } satisfies HubOutletContext} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

export function DesktopRequired() {
  return (
    <main className={styles.desktopRequired}>
      <div className={styles.desktopWindow} aria-hidden="true">
        <span /><span /><span />
        <div><X /><Menu /></div>
      </div>
      <p className={styles.eyebrow}>Project Hub</p>
      <h1>A wider workbench is required</h1>
      <p>MEX Hub is designed for desktop workflows at 1024 pixels and above. Widen this window to continue.</p>
    </main>
  );
}
