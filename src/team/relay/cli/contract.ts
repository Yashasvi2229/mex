import { TEAM_RELAY_LIMITS } from "../../contracts/workflow.js";
import type { TeamCommandIo, TeamOutputFlags } from "../../cli/commands.js";
import {
  exitCodeForTeamEnvelope,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
} from "../../cli/envelope.js";
import {
  RELAY_CONTRACT_COMMAND,
  relayContractCatalogData,
} from "./contract-catalog.js";

/** Resolve Relay contracts without opening Git, Home, or a repository service. */
export function runRelayContract(flags: TeamOutputFlags, io: TeamCommandIo): void {
  let envelope = teamEnvelope({
    command: "relay.contract",
    mode: "read",
    data: relayContractCatalogData(),
  });
  let rendered = renderTeamEnvelope(envelope);
  if (Buffer.byteLength(rendered, "utf8") > TEAM_RELAY_LIMITS.maxEnvelopeBytes) {
    envelope = teamProblemEnvelope(
      "relay.contract",
      "read",
      new Error("The static Relay contract catalog exceeded its bounded envelope."),
    );
    rendered = renderTeamEnvelope(envelope);
  }
  if (flags.json === true) io.write(rendered);
  else io.write(`Run ${RELAY_CONTRACT_COMMAND} to emit the versioned machine contract catalog.`);
  io.setExitCode(exitCodeForTeamEnvelope(envelope));
}
