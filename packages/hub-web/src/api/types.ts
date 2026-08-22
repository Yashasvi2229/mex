export type {
  BootstrapResponse,
  CapabilityStatus,
  HealthResponse,
  HomeResponse,
  HubActor,
  HubCapabilities as CapabilitiesResponse,
  HubJobKind as JobKind,
  HubJobProgress as JobProgress,
  HubJobSnapshot as JobSummary,
  HubJobState as JobState,
  HubProblemDetails as ProblemDetails,
  JobPageResponse as JobsResponse,
  JobStartRequest as StartJobRequest,
  SearchResponse,
  SessionResponse,
} from "@mex/hub-contracts";

export type CapabilityName = "graph" | "wiki" | "jobs" | "team";
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
