import { readFileSync } from "node:fs";

const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
const CONFIRMABLE_RUNTIME_METRICS = confirmableRuntimeMetrics(budgets.runtime);

const MAX_VIOLATIONS = 200;

export function classifyRuntimeViolations(violations) {
  const confirmable = [];
  const immediate = [];
  for (const violation of violations.slice(0, MAX_VIOLATIONS)) {
    const destination = isConfirmableRuntimeMetric(violation.metric)
      ? confirmable
      : immediate;
    destination.push(violation);
  }
  return { confirmable, immediate };
}

export function evaluateRuntimeConfirmation(firstPassViolations, secondPassViolations) {
  const first = classifyRuntimeViolations(firstPassViolations);
  if (first.immediate.length > 0) {
    return {
      retryRequired: false,
      status: "skipped_immediate_failure",
      finalViolations: first.immediate,
      first,
      second: { confirmable: [], immediate: [] },
      confirmed: [],
    };
  }
  if (first.confirmable.length === 0) {
    return {
      retryRequired: false,
      status: "not_required",
      finalViolations: [],
      first,
      second: { confirmable: [], immediate: [] },
      confirmed: [],
    };
  }
  if (secondPassViolations === undefined) {
    return {
      retryRequired: true,
      status: "required",
      finalViolations: [],
      first,
      second: { confirmable: [], immediate: [] },
      confirmed: [],
    };
  }

  const second = classifyRuntimeViolations(secondPassViolations);
  const firstMetrics = new Set(first.confirmable.map((violation) => violation.metric));
  const confirmed = second.confirmable.filter((violation) => firstMetrics.has(violation.metric));
  const finalViolations = [...second.immediate, ...confirmed].slice(0, MAX_VIOLATIONS);
  return {
    retryRequired: false,
    status: finalViolations.length === 0 ? "passed" : "failed",
    finalViolations,
    first,
    second,
    confirmed,
  };
}

function isConfirmableRuntimeMetric(metric) {
  return typeof metric === "string" && CONFIRMABLE_RUNTIME_METRICS.has(metric);
}

function confirmableRuntimeMetrics(runtimeBudgets) {
  const metrics = new Set();
  for (const name of ["coldHubReadyMs", "idleRssBytes", "idleCpuMs"]) {
    for (const profile of Object.keys(runtimeBudgets[name] ?? {})) {
      metrics.add(`runtime.${name}.${profile}`);
    }
  }
  for (const name of [
    "apiLatencyMs",
    "maintenanceMs",
    "maintenancePeakRssBytes",
    "browserHeapBytes",
  ]) {
    for (const [profile, entries] of Object.entries(runtimeBudgets[name] ?? {})) {
      for (const metric of Object.keys(entries)) {
        metrics.add(`runtime.${name}.${profile}.${metric}`);
      }
    }
  }
  return metrics;
}
