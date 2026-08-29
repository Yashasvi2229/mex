import { describe, expect, it } from "vitest";
import type {
  ActorRef,
  RepoState,
  Revision,
} from "../../src/team/contracts/shared.js";
import type {
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayDraftDetail,
  TeamRelayHandoffPort,
  TeamRelayPreviewEnvelope,
} from "../../src/team/contracts/workflow.js";

export const TEAM_RELAY_RECOVERY_PHASES = [
  "publish.after-relay",
  "publish.after-activity",
  "publish.after-cleanup",
  "acknowledge.after-relay",
  "acknowledge.after-activity",
  "close.after-relay",
  "close.after-activity",
] as const;

export type TeamRelayRecoveryPhase =
  (typeof TEAM_RELAY_RECOVERY_PHASES)[number];
export type TeamRelayScenario =
  | "empty"
  | "populated"
  | "uninitialized-local"
  | "no-current-member"
  | "legacy-v1";

export interface TeamRelaySnapshot {
  canonicalDigest: Revision;
  localStateDigest: Revision | null;
  signerDigest: Revision | null;
  gitHead: string | null;
  relayIds: readonly string[];
  draftIds: readonly string[];
  activityIds: readonly string[];
  outboundRequests: number;
  modelInvocations: number;
}

export interface TeamRelayContractHarness {
  port: TeamRelayHandoffPort;
  oracle: {
    now: string;
    actor: ActorRef;
    sender: ActorRef;
    recipient: ActorRef;
    repoState: RepoState;
    populatedDraft: TeamRelayDraftDetail | null;
    populatedRelay: TeamRelayDetail | null;
  };
  makeDraftCommand(operationId: string): Promise<TeamRelayCommand>;
  commandFor(
    kind: "relay.publish" | "relay.acknowledge" | "relay.close",
    target: TeamRelayDraftDetail | TeamRelayDetail,
    operationId: string,
  ): Promise<TeamRelayCommand>;
  selectActor(actor: "sender" | "recipient" | "none"): Promise<TeamRelayHandoffPort>;
  restart(): Promise<TeamRelayHandoffPort>;
  removeSigner(): Promise<void>;
  armCrash(phase: TeamRelayRecoveryPhase): Promise<void>;
  snapshot(): Promise<TeamRelaySnapshot>;
  close(): Promise<void>;
}

export interface TeamRelayContractFactory {
  open(scenario: TeamRelayScenario): Promise<TeamRelayContractHarness>;
}

/** Consumer-owned F1 contract. F0 deliberately provides no registration. */
export function defineTeamRelayHandoffContract(
  adapterName: string,
  factory: TeamRelayContractFactory,
): void {
  describe(`${adapterName} Relay handoff contract`, () => {
    it("keeps ordinary draft and Relay reads noninitializing", async () => {
      await withHarness(factory, "uninitialized-local", async (harness) => {
        const before = await harness.snapshot();
        expect(before.localStateDigest).toBeNull();
        await expect(harness.port.getRelayDraft("relay_missing")).resolves.toBeNull();
        await expect(harness.port.getRelay("relay_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
          .resolves.toBeNull();
        await expect(harness.port.listRelayDrafts()).resolves.toMatchObject({ items: [] });
        await expect(harness.port.listRelays()).resolves.toMatchObject({ items: [] });
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("saves a local draft without canonical authority and signs only exact apply", async () => {
      await withHarness(factory, "no-current-member", async (harness) => {
        const request = await harness.makeDraftCommand("relay_contract_draft_save");
        const preview = await harness.port.previewRelay(request);
        expect(preview.preview.scope).toBe("local");
        expect(preview.receipt.purposeIds).toHaveLength(1);
        expect(preview.receipt.purposeIds[0]?.purpose).toBe("relay-draft");
        const result = await harness.port.applyRelay(preview);
        expect(result.localChanges).toHaveLength(1);
        expect(result.relays).toEqual([]);
        expect(result.events).toEqual([]);

        const altered = structuredClone(preview);
        altered.request.operationId = "relay_contract_altered";
        await expect(harness.port.applyRelay(altered)).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
      });
    });

    it("publishes, first-claims, and closes with exact activity cardinality", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = harness.oracle.populatedDraft;
        if (draft === null) throw new Error("Relay fixture has no draft.");
        const publish = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_publish"),
        );
        expect(publish.receipt.purposeIds.map((item) => item.purpose))
          .toEqual(["activity", "relay"]);
        const published = await harness.port.applyRelay(publish);
        expect(published.relays).toHaveLength(1);
        expect(published.events).toHaveLength(1);
        expect(published.relays[0]?.publishedAt).toBe(harness.oracle.now);

        const recipientPort = await harness.selectActor("recipient");
        const relay = published.relays[0]!;
        const acknowledge = await recipientPort.previewRelay(
          await harness.commandFor(
            "relay.acknowledge",
            relay,
            "relay_contract_acknowledge",
          ),
        );
        const acknowledged = await recipientPort.applyRelay(acknowledge);
        expect(acknowledged.relays[0]).toMatchObject({ state: "acknowledged" });
        expect(acknowledged.events).toHaveLength(1);

        const close = await recipientPort.previewRelay(
          await harness.commandFor(
            "relay.close",
            acknowledged.relays[0]!,
            "relay_contract_close",
          ),
        );
        const closed = await recipientPort.applyRelay(close);
        expect(closed.relays[0]).toMatchObject({ state: "closed" });
        expect(closed.events).toHaveLength(1);
      });
    });

    it("requires current Member authority for personal views and canonical actions", async () => {
      await withHarness(factory, "no-current-member", async ({ port }) => {
        await expect(port.listRelays({ perspective: "mine" })).rejects.toMatchObject({
          problem: { code: "UNAUTHORIZED" },
        });
        await expect(port.listRelays({ perspective: "sent" })).rejects.toMatchObject({
          problem: { code: "UNAUTHORIZED" },
        });
        await expect(port.listRelays({ perspective: "all" })).resolves.toBeDefined();
        await expect(port.listRelayDrafts()).resolves.toBeDefined();
      });
    });

    it("projects legacy v1 publication time as null without rewriting bytes", async () => {
      await withHarness(factory, "legacy-v1", async (harness) => {
        const before = await harness.snapshot();
        const page = await harness.port.listRelays({ perspective: "all" });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ schemaVersion: 1, publishedAt: null });
        expect(page.diagnostics).toHaveLength(1);
        expect(await harness.snapshot()).toEqual(before);
      });
    });

    it("rejects envelopes after signer loss before journal intent", async () => {
      await withHarness(factory, "populated", async (harness) => {
        const draft = harness.oracle.populatedDraft;
        if (draft === null) throw new Error("Relay fixture has no draft.");
        const envelope = await harness.port.previewRelay(
          await harness.commandFor("relay.publish", draft, "relay_contract_signer_loss"),
        );
        await harness.removeSigner();
        const restarted = await harness.restart();
        await expect(restarted.applyRelay(envelope)).rejects.toMatchObject({
          problem: { code: "REVISION_CONFLICT" },
        });
      });
    });
  });
}

async function withHarness(
  factory: TeamRelayContractFactory,
  scenario: TeamRelayScenario,
  run: (harness: TeamRelayContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory.open(scenario);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}
