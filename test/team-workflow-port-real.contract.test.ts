import { existsSync } from "node:fs";
import { describe } from "vitest";
import {
  defineTeamWorkflowPortContract,
  type TeamWorkflowPortContractFactory,
} from "./contracts/team-workflow-port.contract.js";

/*
 * Activation is intentionally consumer-owned. Once the concrete internal
 * adapter lands, this registration imports
 * `createRepositoryTeamWorkflowPort` from `../src/team/workflow/index.js` and
 * opens real filesystem/local-state/Git fixtures with injected wiki, git, now,
 * idFactories, and phaseHook dependencies. The adapter is not package-exported.
 *
 * Keeping the pending registration collected (but skipped) makes Vitest load
 * and transpile the complete reusable contract without inventing a production
 * shim before the concrete port exists. The skip is automatically removed as
 * soon as that module appears, so integration cannot leave this placeholder
 * silently disabled; the real fixture must replace `pendingRepositoryFactory`.
 */
const pendingRepositoryFactory: TeamWorkflowPortContractFactory<unknown> = {
  async open() {
    throw new Error("The repository TeamWorkflowPort factory has not landed yet.");
  },
};

const concreteFactoryExists = existsSync(new URL("../src/team/workflow/index.ts", import.meta.url))
  || existsSync(new URL("../src/team/workflow/index.js", import.meta.url));
const registration = concreteFactoryExists ? describe : describe.skip;

registration("repository TeamWorkflowPort registration pending concrete adapter", () => {
  defineTeamWorkflowPortContract("repository adapter", pendingRepositoryFactory);
});
