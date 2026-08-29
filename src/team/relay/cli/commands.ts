import { isArtifactId } from "../../artifacts/ulid.js";
import { MexPortError } from "../../contracts/shared.js";
import {
  RELAY_STATES,
  TEAM_RELAY_LIMITS,
  type RelayState,
  type TeamRelayApplyResult,
  type TeamRelayDetail,
  type TeamRelayDraftDetail,
  type TeamRelayDraftSummary,
  type TeamRelayPage,
  type TeamRelayPerspective,
  type TeamRelayPreviewEnvelope,
  type TeamRelaySummary,
} from "../../contracts/workflow.js";
import type {
  TeamCommandIo,
  TeamMutationFlags,
  TeamOutputFlags,
  TeamPageFlags,
} from "../../cli/commands.js";
import {
  exitCodeForTeamEnvelope,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
  TeamCliUsageError,
  type TeamCliCommandName,
  type TeamCliEnvelope,
  type TeamCliMode,
} from "../../cli/envelope.js";
import {
  projectRelay,
  projectRelayApply,
  projectRelayDraft,
  projectRelayDraftPage,
  projectRelayPage,
  projectRelayPreview,
} from "./projections.js";
import { isRelayLocalId } from "../handoff.js";
import {
  readRelayCommandFile,
  readRelayPreviewFile,
  type RelayMutationCommandName,
} from "./request-file.js";
import type { TeamRelayCliService, TeamRelayCliServiceFactory } from "./service.js";

export interface RelayListFlags extends TeamPageFlags {
  perspective?: string;
  state?: string | readonly string[];
  workstream?: string;
}

export type RelayCliServiceSource = TeamRelayCliService | TeamRelayCliServiceFactory;

export async function runRelayDraftList(
  source: RelayCliServiceSource,
  flags: TeamPageFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("relay.draft.list", "read", flags, io, async () => {
    const request = pageRequest(flags);
    const page = projectRelayDraftPage(
      await (await resolveService(source)).listRelayDrafts(request),
    );
    return teamEnvelope({
      command: "relay.draft.list",
      mode: "read",
      data: page,
      diagnostics: page.diagnostics,
    });
  }, renderDraftList);
}

export async function runRelayDraftShow(
  source: RelayCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("relay.draft.show", "read", flags, io, async () => {
    assertLocalId(id);
    const draft = await (await resolveService(source)).getRelayDraft(id);
    if (draft === null) throw notFound("Relay draft", id);
    return teamEnvelope({ command: "relay.draft.show", mode: "read", data: projectRelayDraft(draft) });
  }, renderDraft);
}

export async function runRelayList(
  source: RelayCliServiceSource,
  flags: RelayListFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("relay.list", "read", flags, io, async () => {
    const perspective = relayPerspective(flags.perspective);
    const states = relayStates(flags.state);
    if (flags.workstream !== undefined && !isArtifactId(flags.workstream, "ws")) {
      throw new TeamCliUsageError("--workstream must be a ws_ prefixed ULID.");
    }
    const request = pageRequest(flags);
    const page = projectRelayPage(await (await resolveService(source)).listRelays({
      ...request,
      ...(perspective === undefined ? {} : { perspective }),
      ...(states.length === 0 ? {} : { states }),
      ...(flags.workstream === undefined ? {} : { workstreamId: flags.workstream }),
    }));
    return teamEnvelope({
      command: "relay.list",
      mode: "read",
      data: page,
      diagnostics: page.diagnostics,
    });
  }, renderRelayList);
}

export async function runRelayShow(
  source: RelayCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("relay.show", "read", flags, io, async () => {
    assertRelayId(id);
    const relay = await (await resolveService(source)).getRelay(id);
    if (relay === null) throw notFound("Relay", id);
    const projected = projectRelay(relay);
    return teamEnvelope({
      command: "relay.show",
      mode: "read",
      data: projected,
      diagnostics: projected.diagnostics,
    });
  }, renderRelay);
}

export async function runRelayMutation(
  source: RelayCliServiceSource,
  command: RelayMutationCommandName,
  requestFile: string | undefined,
  flags: TeamMutationFlags,
  io: TeamCommandIo,
): Promise<void> {
  if (flags.apply === undefined) {
    await execute(command, "preview", flags, io, async () => {
      if (requestFile === undefined) {
        throw new TeamCliUsageError("A Relay request JSON file is required for preview.");
      }
      const request = readRelayCommandFile(requestFile, command);
      const preview = projectRelayPreview(
        await (await resolveService(source)).previewRelay(request),
      );
      const envelope = teamEnvelope({
        command,
        mode: "preview",
        data: preview,
        diagnostics: preview.preview.diagnostics,
        valid: preview.preview.valid,
      });
      assertSavableRelayPreview(envelope);
      return envelope;
    }, renderPreview);
    return;
  }

  await execute(command, "apply", flags, io, async () => {
    if (requestFile !== undefined) {
      throw new TeamCliUsageError(
        "Apply accepts only --apply <preview-envelope.json>; do not also pass a request file.",
      );
    }
    const preview = readRelayPreviewFile(flags.apply!, command);
    const result = projectRelayApply(
      await (await resolveService(source)).applyRelay(preview),
    );
    return teamEnvelope({ command, mode: "apply", data: result });
  }, renderApply);
}

/** `console.log` adds one byte; saved output must remain readable by apply. */
function assertSavableRelayPreview(
  envelope: TeamCliEnvelope<TeamRelayPreviewEnvelope>,
): void {
  const outputBytes = Buffer.byteLength(renderTeamEnvelope(envelope), "utf8") + 1;
  if (outputBytes <= TEAM_RELAY_LIMITS.maxEnvelopeBytes) return;
  throw new MexPortError({
    title: "Relay preview exceeds CLI envelope limit",
    status: 422,
    code: "VALIDATION_FAILED",
    detail:
      `The complete Relay preview envelope exceeds ${TEAM_RELAY_LIMITS.maxEnvelopeBytes} bytes and cannot be saved for apply. Reduce the Relay draft content and preview again.`,
  });
}

async function execute<T>(
  command: TeamCliCommandName,
  mode: TeamCliMode,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
  operation: () => Promise<TeamCliEnvelope<T>>,
  human: (data: T, envelope: TeamCliEnvelope<T>, io: TeamCommandIo) => void,
): Promise<void> {
  let envelope: TeamCliEnvelope<T> | TeamCliEnvelope<never>;
  try {
    envelope = await operation();
  } catch (error) {
    envelope = teamProblemEnvelope(command, mode, error);
  }
  if (flags.json === true) {
    io.write(renderTeamEnvelope(envelope));
  } else if (envelope.data === null) {
    const problem = envelope.problem;
    io.write(problem === null ? "Relay command failed validation." : `${problem.code}: ${problem.detail}`);
    for (const diagnostic of envelope.diagnostics) {
      io.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    }
  } else {
    human(envelope.data as T, envelope as TeamCliEnvelope<T>, io);
    for (const diagnostic of envelope.diagnostics) {
      io.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  io.setExitCode(exitCodeForTeamEnvelope(envelope));
}

function pageRequest(flags: TeamPageFlags): { cursor?: string; limit?: number } {
  if (flags.cursor !== undefined && (
    flags.cursor.length === 0
    || Buffer.byteLength(flags.cursor, "utf8") > TEAM_RELAY_LIMITS.maxCursorBytes
    || !/^[A-Za-z0-9_-]+$/u.test(flags.cursor)
  )) {
    throw new TeamCliUsageError(
      `--cursor must be a valid cursor of at most ${TEAM_RELAY_LIMITS.maxCursorBytes} bytes.`,
    );
  }
  return {
    ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
    ...(flags.limit === undefined ? {} : { limit: positiveLimit(flags.limit) }),
  };
}

function positiveLimit(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > TEAM_RELAY_LIMITS.maxPageSize) {
    throw new TeamCliUsageError(
      `--limit must be an integer from 1 to ${TEAM_RELAY_LIMITS.maxPageSize}.`,
    );
  }
  return parsed;
}

function relayPerspective(value: string | undefined): TeamRelayPerspective | undefined {
  if (value === undefined) return undefined;
  if (value !== "mine" && value !== "sent" && value !== "all") {
    throw new TeamCliUsageError("--perspective must be one of: mine, sent, all.");
  }
  return value;
}

function relayStates(value: string | readonly string[] | undefined): readonly RelayState[] {
  const values = value === undefined ? [] : typeof value === "string" ? [value] : value;
  const unique: RelayState[] = [];
  for (const state of values) {
    if (!(RELAY_STATES as readonly string[]).includes(state)) {
      throw new TeamCliUsageError(`--state must be one of: ${RELAY_STATES.join(", ")}.`);
    }
    if (!unique.includes(state as RelayState)) unique.push(state as RelayState);
  }
  return unique;
}

function assertLocalId(value: string): void {
  if (!isRelayLocalId(value)) {
    throw new TeamCliUsageError("Draft ID must be a canonical local identifier of at most 128 bytes.");
  }
}

function assertRelayId(value: string): void {
  if (!isArtifactId(value, "relay")) {
    throw new TeamCliUsageError("Relay ID must be a relay_ prefixed ULID.");
  }
}

function notFound(label: string, id: string): MexPortError {
  return new MexPortError({
    title: `${label} not found`,
    status: 404,
    code: "NOT_FOUND",
    detail: `${label} ${id} does not exist.`,
  });
}

async function resolveService(source: RelayCliServiceSource): Promise<TeamRelayCliService> {
  return typeof source === "function" ? source() : source;
}

function renderDraftList(
  page: TeamRelayPage<TeamRelayDraftSummary>,
  _envelope: TeamCliEnvelope<TeamRelayPage<TeamRelayDraftSummary>>,
  io: TeamCommandIo,
): void {
  if (page.items.length === 0) io.write("No local Relay drafts found.");
  for (const draft of page.items) {
    io.write(`${draft.id}\t${draft.workstream.id}\t${draft.recipients.length}\t${draft.summary}`);
  }
  renderContinuation(page, io);
}

function renderDraft(
  draft: TeamRelayDraftDetail,
  _envelope: TeamCliEnvelope<TeamRelayDraftDetail>,
  io: TeamCommandIo,
): void {
  io.write(`${draft.summary} (${draft.id})`);
  io.write(`Workstream: ${draft.workstream.id}`);
  io.write(`Recipients: ${draft.recipients.map((recipient) => recipient.memberId).join(", ")}`);
  io.write(`Revision: ${draft.revision}`);
  io.write(`Updated: ${draft.updatedAt}`);
}

function renderRelayList(
  page: TeamRelayPage<TeamRelaySummary>,
  _envelope: TeamCliEnvelope<TeamRelayPage<TeamRelaySummary>>,
  io: TeamCommandIo,
): void {
  if (page.items.length === 0) io.write("No canonical Relays found.");
  for (const relay of page.items) {
    io.write(`${relay.ref.id}\t${relay.state}\t${relay.workstream.id}\t${relay.summary}`);
  }
  renderContinuation(page, io);
}

function renderRelay(
  relay: TeamRelayDetail,
  _envelope: TeamCliEnvelope<TeamRelayDetail>,
  io: TeamCommandIo,
): void {
  io.write(`${relay.summary} (${relay.ref.id})`);
  io.write(`State: ${relay.state}`);
  io.write(`Workstream: ${relay.workstream.id}`);
  io.write(`Published: ${relay.publishedAt ?? "legacy timestamp unavailable"}`);
  io.write(`Revision: ${relay.revision}`);
}

function renderPreview(
  preview: TeamRelayPreviewEnvelope,
  envelope: TeamCliEnvelope<TeamRelayPreviewEnvelope>,
  io: TeamCommandIo,
): void {
  io.write(`${envelope.ok ? "Valid" : "Invalid"} ${preview.preview.scope} preview for ${preview.request.operationId}`);
  io.write(`Canonical changes: ${preview.preview.changes.length}`);
  io.write(`Local changes: ${preview.preview.localChanges.length}`);
  io.write(`Preview revision: ${preview.receipt.previewRevision}`);
  io.write("Use --json to save this complete approval envelope before apply.");
}

function renderApply(
  result: TeamRelayApplyResult,
  _envelope: TeamCliEnvelope<TeamRelayApplyResult>,
  io: TeamCommandIo,
): void {
  io.write(`${result.idempotentReplay ? "Replayed" : "Applied"} ${result.operationId}`);
  io.write(`Canonical changes: ${result.changes.length}`);
  io.write(`Local changes: ${result.localChanges.length}`);
  io.write(`Relays: ${result.relays.length}`);
  io.write(`Activity events: ${result.events.length}`);
}

function renderContinuation(
  page: { nextCursor: string | null; sourceTruncated: boolean },
  io: TeamCommandIo,
): void {
  if (page.nextCursor !== null) io.write(`Next cursor: ${page.nextCursor}`);
  if (page.sourceTruncated) io.write("Warning: the bounded source scan was incomplete.");
}
