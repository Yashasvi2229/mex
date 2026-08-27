import {
  Activity,
  BookOpenText,
  Code2,
  FileCheck2,
  GitPullRequestArrow,
  HeartPulse,
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

export interface NavigationItem {
  label: string;
  path: string;
  icon: LucideIcon;
  capability?: CapabilityName;
  structuralUnavailable?: boolean;
}

export interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}

export const navigation: NavigationGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Home", path: "/", icon: House },
      { label: "Search", path: "/search", icon: Search },
    ],
  },
  {
    label: "Project",
    items: [
      { label: "Knowledge", path: "/knowledge", icon: BookOpenText, capability: "wiki" },
      { label: "Code", path: "/code", icon: Code2, capability: "graph" },
      { label: "Workstreams", path: "/workstreams", icon: Workflow, structuralUnavailable: true },
      { label: "Specs", path: "/specs", icon: FileCheck2, structuralUnavailable: true },
      { label: "Playbooks", path: "/playbooks", icon: ListChecks, structuralUnavailable: true },
    ],
  },
  {
    label: "Team",
    items: [
      { label: "Members", path: "/members", icon: UsersRound, capability: "members" },
      { label: "Inbox", path: "/inbox", icon: Inbox, capability: "team" },
      { label: "Relays", path: "/relays", icon: Send, capability: "team" },
      { label: "Activity", path: "/activity", icon: Activity, capability: "activity" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Jobs", path: "/jobs", icon: GitPullRequestArrow, capability: "jobs" },
      { label: "Health", path: "/health", icon: HeartPulse },
    ],
  },
];
