import { BrowserRouter, Route, Routes } from "react-router-dom";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider, useCapabilities, useSession } from "../api/context";
import { StatePanel } from "../components/ui";
import { CapabilityPage, NotFoundPage } from "../pages/CapabilityPage";
import { ActivityPage } from "../pages/ActivityPage";
import { HealthPage } from "../pages/HealthPage";
import { HomePage } from "../pages/HomePage";
import { JobsPage } from "../pages/JobsPage";
import { SearchPage } from "../pages/SearchPage";
import styles from "../styles/hub.module.css";
import { DesktopRequired, HubLayout } from "./HubLayout";

function SessionBoundary() {
  const session = useSession();
  const capabilities = useCapabilities();

  if (session.isPending) {
    return <div className={styles.fullPageState}><StatePanel state="loading" title="Opening Project Hub" detail="Verifying this process-local session." /></div>;
  }

  if (session.isError) {
    const expired = session.error instanceof HubApiError && session.error.problem.code === "UNAUTHORIZED";
    return (
      <div className={styles.fullPageState}>
        <StatePanel
          state="unavailable"
          title={expired ? "This Hub session has expired" : "A Hub session is required"}
          detail="Close this tab and run `mex hub` again. A fresh one-use link will create a new local session."
        />
      </div>
    );
  }

  return <HubLayout capabilities={capabilities.data} session={session.data} />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<SessionBoundary />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="knowledge" element={<CapabilityPage page="knowledge" />} />
        <Route path="code" element={<CapabilityPage page="code" />} />
        <Route path="workstreams" element={<CapabilityPage page="workstreams" />} />
        <Route path="specs" element={<CapabilityPage page="specs" />} />
        <Route path="playbooks" element={<CapabilityPage page="playbooks" />} />
        <Route path="inbox" element={<CapabilityPage page="inbox" />} />
        <Route path="relays" element={<CapabilityPage page="relays" />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function HubApplication({ api, startupError }: { api: HubApi; startupError?: Error | null }) {
  return (
    <HubApiProvider api={api}>
      <div className={styles.desktopOnly}>
        {startupError ? (
          <div className={styles.fullPageState}>
            <StatePanel state="error" title="The one-use Hub link was not accepted" detail={startupError.message} />
          </div>
        ) : <AppRoutes />}
      </div>
      <div className={styles.compactOnly}><DesktopRequired /></div>
    </HubApiProvider>
  );
}

export function BrowserHubApplication(props: { api: HubApi; startupError?: Error | null }) {
  return <BrowserRouter><HubApplication {...props} /></BrowserRouter>;
}
