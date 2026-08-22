import { describe, expect, it } from "vitest";
import {
  isTelemetryExemptCommand,
  parsePortArg,
  program,
} from "../src/cli.js";

describe("mex hub command surface", () => {
  it("registers the Hub command and its two public options", () => {
    const command = program.commands.find((candidate) => candidate.name() === "hub");
    expect(command).toBeDefined();
    expect(command?.options.map((option) => option.long)).toEqual([
      "--port",
      "--no-open",
    ]);
  });

  it("accepts only valid explicit TCP ports", () => {
    expect(parsePortArg("1")).toBe(1);
    expect(parsePortArg("65535")).toBe(65_535);
    expect(() => parsePortArg("0")).toThrow(/positive integer/);
    expect(() => parsePortArg("65536")).toThrow(/1 to 65535/);
    expect(() => parsePortArg("1junk")).toThrow();
  });

  it("keeps Hub launch and actions outside command telemetry", () => {
    expect(isTelemetryExemptCommand("hub", "mex")).toBe(true);
    expect(isTelemetryExemptCommand("check", "mex")).toBe(false);
  });
});
