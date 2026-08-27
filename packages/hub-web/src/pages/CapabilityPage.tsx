import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BookOpenText,
  Code2,
  GitPullRequestArrow,
  Inbox,
  ListChecks,
  Send,
} from "lucide-react";
import { Link, useLocation, useOutletContext } from "react-router-dom";
import type { CapabilitiesResponse, CapabilityName, CapabilityStatus } from "../api/types";
import { PageHeader } from "../components/ui";
import { Badge } from "../components/primitives/badge";
import { buttonVariants } from "../components/primitives/button";
import { Card, CardContent } from "../components/primitives/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import { cn } from "../lib/utils";
import capabilityStyles from "../styles/capability.module.css";
import notFoundStyles from "../styles/not-found.module.css";

interface CapabilityPageDefinition {
  title: string;
  capability: CapabilityName;
  icon: LucideIcon;
  connectedCopy: string;
  unavailableCopy: string;
  structuralUnavailable?: boolean;
}

export const capabilityPages: Record<string, CapabilityPageDefinition> = {
  knowledge: {
    title: "Knowledge", capability: "wiki", icon: BookOpenText,
    connectedCopy: "Knowledge browsing is unavailable.",
    unavailableCopy: "Knowledge is unavailable.",
  },
  code: {
    title: "Code", capability: "graph", icon: Code2,
    connectedCopy: "Code browsing is unavailable.",
    unavailableCopy: "Code is unavailable.",
  },
  playbooks: {
    title: "Playbooks", capability: "wiki", icon: ListChecks,
    connectedCopy: "Playbooks are unavailable.",
    unavailableCopy: "Playbooks are unavailable.",
    structuralUnavailable: true,
  },
  inbox: {
    title: "Inbox", capability: "team", icon: Inbox,
    connectedCopy: "Inbox is unavailable.",
    unavailableCopy: "Inbox is unavailable.",
  },
  relays: {
    title: "Relays", capability: "team", icon: Send,
    connectedCopy: "Relays are unavailable.",
    unavailableCopy: "Relays are unavailable.",
  },
};

function capabilityStatus(capabilities: CapabilitiesResponse | undefined, name: CapabilityName): CapabilityStatus | undefined {
  if (!capabilities) return undefined;
  if (name === "graph") return capabilities.graph.read;
  if (name === "wiki") return capabilities.wiki.read;
  if (name === "jobs") return capabilities.jobs;
  if (name === "activity") return capabilities.activity;
  if (name === "members") return capabilities.members.read;
  if (name === "workstreams") return capabilities.workstreams.read;
  if (name === "specs") return capabilities.specs.read;
  return undefined;
}

export function CapabilityPage({ page }: { page: keyof typeof capabilityPages }) {
  const definition = capabilityPages[page];
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const capability = capabilityStatus(capabilities, definition.capability);
  const checking = capabilities === undefined;
  const dependencyAvailable = !definition.structuralUnavailable
    && !checking
    && capability?.availability === "available";
  const state = checking ? "checking" : dependencyAvailable ? "connected" : "unavailable";
  const stateLabel = checking ? "Checking" : dependencyAvailable ? "Dependency connected" : "Unavailable";
  const boundaryTitle = checking
    ? `Checking ${definition.title.toLowerCase()} availability`
    : dependencyAvailable
      ? definition.connectedCopy
      : definition.unavailableCopy;
  const boundaryReason = checking
    ? "Checking the local capability manifest."
    : dependencyAvailable
      ? "This surface is not mounted."
      : definition.structuralUnavailable
        ? "This read-only checkpoint does not mount this product surface."
        : definition.capability === "wiki"
        ? "Wiki is not connected."
        : definition.capability === "team"
          ? "Team features are not connected."
          : "The code graph is not connected.";
  const Icon = definition.icon;

  return (
    <div className={capabilityStyles.page}>
      <PageHeader
        title={definition.title}
        actions={(
          <Badge className={capabilityStyles.headerStatus} data-state={state} role="status" variant="outline">
            <span className={capabilityStyles.statusDot} aria-hidden="true" />
            {stateLabel}
          </Badge>
        )}
      />

      <Card className={capabilityStyles.boundaryCard} size="sm" aria-labelledby="capability-boundary-title">
        <CardContent className={capabilityStyles.boundaryContent}>
          <Empty className={capabilityStyles.boundaryEmpty}>
            <EmptyMedia className={capabilityStyles.capabilityIcon} data-state={state} variant="icon">
              <Icon aria-hidden="true" />
            </EmptyMedia>
            <EmptyHeader className={capabilityStyles.boundaryHeader}>
              <EmptyTitle id="capability-boundary-title" role="heading" aria-level={2}>{boundaryTitle}</EmptyTitle>
              <EmptyDescription>{boundaryReason}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent className={capabilityStyles.boundaryMeta}>
              <Badge variant="outline"><code>{definition.capability}</code></Badge>
              <Badge variant="outline">Read only</Badge>
              <Badge variant="outline">No data requested</Badge>
            </EmptyContent>
          </Empty>
        </CardContent>
      </Card>
    </div>
  );
}

export function NotFoundPage() {
  const location = useLocation();
  const requestedPath = location.pathname || "/";

  return (
    <div className={notFoundStyles.page}>
      <Card className={notFoundStyles.resolutionCard} size="sm">
        <CardContent className={notFoundStyles.resolutionContent}>
          <Empty className={notFoundStyles.resolution}>
            <EmptyMedia className={notFoundStyles.routeIcon} variant="icon">
              <GitPullRequestArrow aria-hidden="true" />
            </EmptyMedia>
            <Badge className={notFoundStyles.code} variant="outline">404</Badge>
            <EmptyHeader className={notFoundStyles.resolutionHeader}>
              <EmptyTitle id="route-resolution-title" role="heading" aria-level={1}>Page not found</EmptyTitle>
              <EmptyDescription>No route matches this address.</EmptyDescription>
            </EmptyHeader>
            <code className={notFoundStyles.requestPath}>{requestedPath}</code>
            <EmptyContent>
              <Link className={cn(buttonVariants({ size: "sm" }), notFoundStyles.returnLink)} to="/">
                <ArrowLeft aria-hidden="true" data-icon="inline-start" />
                Return home
              </Link>
            </EmptyContent>
          </Empty>
        </CardContent>
      </Card>
    </div>
  );
}
