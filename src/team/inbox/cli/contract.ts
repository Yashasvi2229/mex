import {
  inboxContractCatalogData,
  INBOX_CONTRACT_COMMAND,
} from "../../../capabilities.js";
import { TEAM_INBOX_SPEC_LIMITS } from "../../contracts/workflow.js";
import type { TeamCommandIo, TeamOutputFlags } from "../../cli/commands.js";
import {
  exitCodeForTeamEnvelope,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
} from "../../cli/envelope.js";

/**
 * Resolve the governed Inbox contracts without opening a repository service.
 *
 * This command is intentionally static: it is usable before Git or `.mex`
 * exists, never initializes Team state, and carries the ordinary Team JSON
 * envelope so malformed JSON-mode invocations keep the same typed exits.
 */
export function runInboxContract(flags: TeamOutputFlags, io: TeamCommandIo): void {
  let envelope = teamEnvelope({
    command: "inbox.contract",
    mode: "read",
    data: inboxContractCatalogData(),
  });
  let rendered = renderTeamEnvelope(envelope);
  if (Buffer.byteLength(rendered, "utf8") > TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes) {
    envelope = teamProblemEnvelope(
      "inbox.contract",
      "read",
      new Error("The static Inbox contract catalog exceeded its bounded envelope."),
    );
    rendered = renderTeamEnvelope(envelope);
  }
  if (flags.json === true) io.write(rendered);
  else io.write(`Run ${INBOX_CONTRACT_COMMAND} to emit the versioned machine contract catalog.`);
  io.setExitCode(exitCodeForTeamEnvelope(envelope));
}
