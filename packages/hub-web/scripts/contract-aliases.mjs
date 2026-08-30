import { resolve } from "node:path";

export function hubContractAliases(packageRoot, command) {
  const source = command === "build"
    ? "../hub-contracts/dist"
    : "../hub-contracts/src";
  const extension = command === "build" ? "js" : "ts";
  return {
    "@mex/hub-contracts/ids": resolve(packageRoot, source, `ids.${extension}`),
    "@mex/hub-contracts/relay": resolve(packageRoot, source, `relay.${extension}`),
    "@mex/hub-contracts": resolve(packageRoot, source, `index.${extension}`),
  };
}
