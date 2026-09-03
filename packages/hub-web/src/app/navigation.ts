import {
  Activity,
  BookOpenText,
  Code2,
  FileCheck2,
  GitPullRequestArrow,
  HeartPulse,
  History,
  House,
  Inbox,
  ListChecks,
  Search,
  Send,
  UsersRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { CapabilityName } from "../api/types";

export type NavigationGroupId = "project-memory" | "teamwork" | "coming-soon" | "system";
export type NavigationPlacement = "launcher" | "primary" | "footer";
export type NavigationCountSource = "inbox" | "relays" | "active-jobs";

export type NavigationAvailability =
  | { kind: "always" }
  | { kind: "runtime"; capability: CapabilityName }
  | { kind: "coming-soon" };

export interface NavigationItem {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  group?: NavigationGroupId;
  placement: NavigationPlacement;
  availability: NavigationAvailability;
  countSource?: Exclude<NavigationCountSource, "active-jobs">;
}

export interface NavigationGroup {
  id: NavigationGroupId;
  label: string;
  placement: Extract<NavigationPlacement, "primary" | "footer">;
  defaultExpanded: boolean;
  countSource?: NavigationCountSource;
}

export const navigationGroups: readonly NavigationGroup[] = [
  { id: "project-memory", label: "Project Memory", placement: "primary", defaultExpanded: true },
  { id: "teamwork", label: "Teamwork", placement: "primary", defaultExpanded: true },
  { id: "coming-soon", label: "Coming Soon", placement: "primary", defaultExpanded: false },
  { id: "system", label: "System", placement: "footer", defaultExpanded: false, countSource: "active-jobs" },
];

export const navigationItems: readonly NavigationItem[] = [
  {
    id: "search",
    label: "Search project",
    path: "/search",
    icon: Search,
    placement: "launcher",
    availability: { kind: "always" },
  },
  {
    id: "overview",
    label: "Overview",
    path: "/",
    icon: House,
    placement: "primary",
    availability: { kind: "always" },
  },
  {
    id: "knowledge",
    label: "Knowledge",
    path: "/knowledge",
    icon: BookOpenText,
    group: "project-memory",
    placement: "primary",
    availability: { kind: "runtime", capability: "wiki" },
  },
  {
    id: "specs",
    label: "Specs",
    path: "/specs",
    icon: FileCheck2,
    group: "project-memory",
    placement: "primary",
    availability: { kind: "runtime", capability: "specs" },
  },
  {
    id: "code",
    label: "Code",
    path: "/code",
    icon: Code2,
    group: "project-memory",
    placement: "primary",
    availability: { kind: "runtime", capability: "graph" },
  },
  {
    id: "workstreams",
    label: "Workstreams",
    path: "/workstreams",
    icon: Workflow,
    group: "teamwork",
    placement: "primary",
    availability: { kind: "runtime", capability: "workstreams" },
  },
  {
    id: "inbox",
    label: "Inbox",
    path: "/inbox",
    icon: Inbox,
    group: "teamwork",
    placement: "primary",
    availability: { kind: "runtime", capability: "inbox" },
    countSource: "inbox",
  },
  {
    id: "relays",
    label: "Relays",
    path: "/relays",
    icon: Send,
    group: "teamwork",
    placement: "primary",
    availability: { kind: "runtime", capability: "relays" },
    countSource: "relays",
  },
  {
    id: "activity",
    label: "Activity",
    path: "/activity",
    icon: Activity,
    group: "teamwork",
    placement: "primary",
    availability: { kind: "runtime", capability: "activity" },
  },
  {
    id: "playbooks",
    label: "Playbooks",
    path: "/playbooks",
    icon: ListChecks,
    group: "coming-soon",
    placement: "primary",
    availability: { kind: "coming-soon" },
  },
  {
    id: "catch-up",
    label: "Catch Up",
    path: "/catch-up",
    icon: History,
    group: "coming-soon",
    placement: "primary",
    availability: { kind: "coming-soon" },
  },
  {
    id: "team",
    label: "Team",
    path: "/members",
    icon: UsersRound,
    placement: "footer",
    availability: { kind: "runtime", capability: "members" },
  },
  {
    id: "health",
    label: "Health",
    path: "/health",
    icon: HeartPulse,
    group: "system",
    placement: "footer",
    availability: { kind: "always" },
  },
  {
    id: "jobs",
    label: "Jobs",
    path: "/jobs",
    icon: GitPullRequestArrow,
    group: "system",
    placement: "footer",
    availability: { kind: "runtime", capability: "jobs" },
  },
];

export function navigationGroup(id: NavigationGroupId): NavigationGroup {
  const group = navigationGroups.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`Unknown navigation group: ${id}`);
  return group;
}

export function navigationItemsForGroup(id: NavigationGroupId): readonly NavigationItem[] {
  return navigationItems.filter((item) => item.group === id);
}

export function navigationItemsForPlacement(
  placement: NavigationPlacement,
): readonly NavigationItem[] {
  return navigationItems.filter((item) => item.placement === placement && item.group === undefined);
}
