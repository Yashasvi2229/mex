import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpenText,
  Boxes,
  Code2,
  FileCheck2,
  GitPullRequestArrow,
  Inbox,
  ListChecks,
  LockKeyhole,
  Send,
  Workflow,
} from "lucide-react";
import { useOutletContext } from "react-router-dom";
import type { CapabilitiesResponse, CapabilityName, CapabilityStatus } from "../api/types";
import { PageHeader, Panel, StatusPill } from "../components/ui";
import styles from "../styles/hub.module.css";

interface CapabilityPageDefinition {
  title: string;
  eyebrow: string;
  description: string;
  capability: CapabilityName;
  icon: LucideIcon;
  availableCopy: string;
  unavailableCopy: string;
  sections: Array<{ title: string; detail: string }>;
}

export const capabilityPages: Record<string, CapabilityPageDefinition> = {
  knowledge: {
    title: "Knowledge", eyebrow: "Project memory", capability: "wiki", icon: BookOpenText,
    description: "Browse durable topics, relationships, provenance, and grounding state.",
    availableCopy: "The Wiki capability is connected. Browsing tools arrive with the read-only integration lane.",
    unavailableCopy: "The Wiki capability is not connected in this build.",
    sections: [{ title: "Topics & relationships", detail: "Structured entities and typed connections." }, { title: "Grounding", detail: "Evidence, backlinks, and health without inferred coverage." }],
  },
  code: {
    title: "Code", eyebrow: "Semantic graph", capability: "graph", icon: Code2,
    description: "Inspect symbols, sources, callers, callees, and impact from the existing graph.",
    availableCopy: "The Graph capability is connected. Read-only exploration arrives after freshness integration.",
    unavailableCopy: "The Graph capability is not available; no placeholder symbols are shown.",
    sections: [{ title: "Symbols & sources", detail: "Grounded definitions and repository paths." }, { title: "Relationships", detail: "Callers, callees, imports, and impact paths." }],
  },
  workstreams: {
    title: "Workstreams", eyebrow: "Coordinated work", capability: "wiki", icon: Workflow,
    description: "A durable project view for goals, ownership, blockers, and next milestones.",
    availableCopy: "Wiki storage is connected; Workstream lifecycle actions are intentionally not part of this foundation.",
    unavailableCopy: "Workstreams require the future Wiki integration.",
    sections: [{ title: "Current state", detail: "Explicit status, scope, blockers, and milestone." }, { title: "Connections", detail: "Specs, decisions, relays, code, and owners." }],
  },
  specs: {
    title: "Specs", eyebrow: "Delivery intent", capability: "wiki", icon: FileCheck2,
    description: "Trace requirements and acceptance criteria to explicit implementation evidence.",
    availableCopy: "Wiki storage is connected; Spec editing is reserved for the SDD checkpoint.",
    unavailableCopy: "Specs require the future Wiki integration.",
    sections: [{ title: "Requirements", detail: "Hierarchy and lifecycle with deliberate deferrals." }, { title: "Traceability", detail: "Explicit links from intent to code and verification." }],
  },
  playbooks: {
    title: "Playbooks", eyebrow: "Repeatable practice", capability: "wiki", icon: ListChecks,
    description: "Keep team-owned procedures grounded in durable project evidence.",
    availableCopy: "Wiki storage is connected; Playbook execution is not shipped in this foundation.",
    unavailableCopy: "Playbooks require the future Wiki integration.",
    sections: [{ title: "Procedures", detail: "Triggers, prerequisites, owners, and ordered steps." }, { title: "Runs", detail: "Explicit status and evidence from human-launched execution." }],
  },
  inbox: {
    title: "Inbox", eyebrow: "Proposed memory", capability: "team", icon: Inbox,
    description: "Review structured knowledge proposals before anything becomes durable project memory.",
    availableCopy: "Team identity is available; proposal workflows arrive in the human-team checkpoint.",
    unavailableCopy: "Inbox proposals are not available in this foundation.",
    sections: [{ title: "Local drafts", detail: "Private proposals that never enter Git until Publish." }, { title: "Review queue", detail: "Exact previews, revisions, and explicit outcomes." }],
  },
  relays: {
    title: "Relays", eyebrow: "Team handoff", capability: "team", icon: Send,
    description: "Publish concise, evidence-backed handoffs tied to active work.",
    availableCopy: "Team identity is available; Relay publish and acknowledgement are not shipped yet.",
    unavailableCopy: "Relays are not available in this foundation.",
    sections: [{ title: "Outgoing", detail: "Completed work, blockers, decisions, and next actions." }, { title: "For you", detail: "Published handoffs with explicit acknowledgement." }],
  },
  activity: {
    title: "Activity", eyebrow: "Repository timeline", capability: "team", icon: Activity,
    description: "Follow immutable, bounded events without prompts, transcripts, or source dumps.",
    availableCopy: "Canonical team activity exists locally; the full timeline view arrives in a later lane.",
    unavailableCopy: "Team activity browsing is not available in this foundation.",
    sections: [{ title: "Repository events", detail: "Deterministic actions and subject references." }, { title: "Catch Up", detail: "Cursor-based summaries that advance only when requested." }],
  },
};

function capabilityStatus(capabilities: CapabilitiesResponse | undefined, name: CapabilityName): CapabilityStatus | undefined {
  if (!capabilities) return undefined;
  if (name === "graph") return capabilities.graph.read;
  if (name === "wiki") return capabilities.wiki.read;
  if (name === "jobs") return capabilities.jobs;
  return capabilities.activity;
}

export function CapabilityPage({ page }: { page: keyof typeof capabilityPages }) {
  const definition = capabilityPages[page];
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const capability = capabilityStatus(capabilities, definition.capability);
  const available = capability?.availability === "available";
  const Icon = definition.icon;
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={definition.eyebrow}
        title={definition.title}
        description={definition.description}
        actions={<StatusPill tone={available ? "success" : "warning"}>{available ? "Foundation ready" : "Unavailable"}</StatusPill>}
      />
      <Panel className={styles.capabilityHero}>
        <span className={styles.capabilityIcon}><Icon aria-hidden="true" /></span>
        <div>
          <p className={styles.panelEyebrow}>{available ? "Capability detected" : "Honest boundary"}</p>
          <h2>{available ? definition.availableCopy : definition.unavailableCopy}</h2>
          <p>{capability?.reason ?? "This route is present now so future behavior has a stable home. It does not create or display fixture records."}</p>
        </div>
        <span className={styles.lockBadge}><LockKeyhole aria-hidden="true" /> Read only</span>
      </Panel>
      <div className={styles.capabilityGrid}>
        {definition.sections.map((section, index) => (
          <Panel className={styles.capabilitySection} key={section.title}>
            <span className={styles.sectionNumber}>0{index + 1}</span>
            <Boxes aria-hidden="true" />
            <h2>{section.title}</h2>
            <p>{section.detail}</p>
            <span>Not yet interactive</span>
          </Panel>
        ))}
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className={styles.notFound}>
      <span className={styles.notFoundCode}>404</span>
      <GitPullRequestArrow aria-hidden="true" />
      <p className={styles.eyebrow}>Route not found</p>
      <h1>This path is outside the workbench.</h1>
      <p>The local Hub has no view at this address. Return to the project overview to keep working.</p>
      <a className={styles.primaryButton} href="/">Return home</a>
    </div>
  );
}
