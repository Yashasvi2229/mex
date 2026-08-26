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
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { CapabilityName } from "../api/types";

export interface NavigationItem {
  label: string;
  path: string;
  icon: LucideIcon;
  capability?: CapabilityName;
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
      { label: "Workstreams", path: "/workstreams", icon: Workflow, capability: "wiki" },
      { label: "Specs", path: "/specs", icon: FileCheck2, capability: "wiki" },
      { label: "Playbooks", path: "/playbooks", icon: ListChecks, capability: "wiki" },
    ],
  },
  {
    label: "Team",
    items: [
      { label: "Inbox", path: "/inbox", icon: Inbox, capability: "team" },
      { label: "Relays", path: "/relays", icon: Send, capability: "team" },
      { label: "Activity", path: "/activity", icon: Activity, capability: "team" },
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
