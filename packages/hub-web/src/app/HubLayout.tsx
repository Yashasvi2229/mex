import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Braces, Circle, GitBranch, GitCommitHorizontal, Menu, ShieldCheck, X } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { CapabilitiesResponse, HomeResponse, SessionResponse } from "../api/types";
import { useHubApi } from "../api/context";
import { navigation } from "./navigation";
import { formatTime, StatusPill } from "../components/ui";
import styles from "../styles/hub.module.css";

function capabilityAvailable(
  capabilities: CapabilitiesResponse | undefined,
  name: "graph" | "wiki" | "jobs" | "activity" | "team" | undefined,
): boolean | undefined {
  if (!name || !capabilities) return undefined;
  if (name === "graph") return capabilities.graph.read.availability === "available";
  if (name === "wiki") return capabilities.wiki.read.availability === "available";
  if (name === "jobs") return capabilities.jobs.availability === "available";
  if (name === "activity") return capabilities.activity.availability === "available";
  return false;
}

function Sidebar({ capabilities }: { capabilities?: CapabilitiesResponse }) {
  return (
    <aside className={styles.sidebar} aria-label="Project Hub navigation">
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true"><Braces /></span>
        <span>
          <strong>MEX</strong>
          <small>Project Hub</small>
        </span>
      </div>
      <nav className={styles.nav} aria-label="Primary">
        {navigation.map((group) => (
          <div className={styles.navGroup} key={group.label}>
            <p>{group.label}</p>
            {group.items.map((item) => {
              const available = capabilityAvailable(capabilities, item.capability);
              return (
                <NavLink
                  end={item.path === "/"}
                  className={({ isActive }) => `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`}
                  key={item.path}
                  to={item.path}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                  {available === false ? <Circle aria-label="Unavailable" className={styles.navUnavailable} /> : null}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div className={styles.localOnly}>
        <ShieldCheck aria-hidden="true" />
        <span><strong>Loopback only</strong><small>No remote connection</small></span>
      </div>
    </aside>
  );
}

function RepositoryBar({ repository, session }: { repository?: HomeResponse["repository"]; session: SessionResponse }) {
  const context = repository;
  return (
    <header className={styles.contextBar} aria-label="Repository context">
      <div className={styles.repoIdentity}>
        <span className={styles.repoGlyph} aria-hidden="true"><Menu /></span>
        <span>
          <small>Repository</small>
          <strong>{context?.name ?? "Current project"}</strong>
        </span>
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
        <span className={styles.sessionDot} aria-hidden="true" />
        <span><strong>Local session</strong><small>Expires {formatTime(session.expiresAt)}</small></span>
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
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);
  const home = useQuery({ queryKey: ["home"], queryFn: () => api.getHome(), retry: false });

  useEffect(() => {
    if (previousPath.current !== location.pathname) {
      mainRef.current?.focus({ preventScroll: true });
      previousPath.current = location.pathname;
    }
  }, [location.pathname]);

  return (
    <div className={styles.viewportFrame}>
      <a className={styles.skipLink} href="#main-content">Skip to main content</a>
      <Sidebar capabilities={capabilities} />
      <div className={styles.workspace}>
        <RepositoryBar repository={home.data?.repository} session={session} />
        <main id="main-content" className={styles.main} ref={mainRef} tabIndex={-1}>
          <Outlet context={{ capabilities }} />
        </main>
      </div>
    </div>
  );
}

export function DesktopRequired() {
  return (
    <div className={styles.desktopRequired}>
      <div className={styles.desktopWindow} aria-hidden="true">
        <span /><span /><span />
        <div><X /><Menu /></div>
      </div>
      <p className={styles.eyebrow}>Project Hub</p>
      <h1>A wider workbench is required</h1>
      <p>MEX Hub is designed for desktop workflows at 1024 pixels and above. Widen this window to continue.</p>
    </div>
  );
}
