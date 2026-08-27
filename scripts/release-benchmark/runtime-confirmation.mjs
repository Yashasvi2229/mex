import { readFileSync } from "node:fs";

const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
const MAX_VIOLATIONS = 200;
const RELATIVE_EXCESS_RATIO = 0.15;
const MIB = 1024 * 1024;
const RUNTIME_MATERIALITY_POLICIES = runtimeMaterialityPolicies(budgets.runtime);

export function classifyRuntimeViolations(violations) {
  const confirmable = [];
  const immediate = [];
  for (const violation of violations.slice(0, MAX_VIOLATIONS)) {
    const destination = isConfirmableRuntimeViolation(violation)
      ? confirmable
      : immediate;
    destination.push(violation);
  }
  return { confirmable, immediate };
}

export function evaluateRuntimeConfirmation(firstPassViolations, secondPassViolations) {
  const first = classifyRuntimeViolations(firstPassViolations);
  if (first.immediate.length > 0) {
    const advisoryAssessments = assessMateriality(first.confirmable, []);
    return {
      retryRequired: false,
      status: "skipped_immediate_failure",
      finalViolations: first.immediate,
      first,
      second: { confirmable: [], immediate: [] },
      confirmed: [],
      advisoryAssessments,
      materialAssessments: [],
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
      advisoryAssessments: [],
      materialAssessments: [],
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
      advisoryAssessments: [],
      materialAssessments: [],
    };
  }

  const second = classifyRuntimeViolations(secondPassViolations);
  const firstMetrics = new Set(first.confirmable.map((violation) => violation.metric));
  const confirmed = second.confirmable.filter((violation) => firstMetrics.has(violation.metric));
  const assessments = assessMateriality(first.confirmable, second.confirmable);
  const advisoryAssessments = assessments.filter((assessment) => assessment.classification === "advisory");
  const materialAssessments = assessments.filter((assessment) => assessment.classification === "material");
  const materialMetrics = new Set(materialAssessments.map((assessment) => assessment.metric));
  const materialViolations = confirmed.filter((violation) => materialMetrics.has(violation.metric));
  const finalViolations = [...second.immediate, ...materialViolations].slice(0, MAX_VIOLATIONS);
  return {
    retryRequired: false,
    status: finalViolations.length === 0 ? "passed" : "failed",
    finalViolations,
    first,
    second,
    confirmed,
    advisoryAssessments,
    materialAssessments,
  };
}

export function runtimeMaterialityPolicy(metric) {
  const policy = RUNTIME_MATERIALITY_POLICIES.get(metric);
  return policy === undefined ? null : { ...policy };
}

function isConfirmableRuntimeViolation(violation) {
  const policy = RUNTIME_MATERIALITY_POLICIES.get(violation?.metric);
  return policy !== undefined
    && violation.reason === "budget_exceeded"
    && violation.budget === policy.budget
    && Number.isFinite(violation.measured)
    && violation.measured > policy.budget;
}

function assessMateriality(firstViolations, secondViolations) {
  const firstByMetric = new Map(firstViolations.map((violation) => [violation.metric, violation]));
  const secondByMetric = new Map(secondViolations.map((violation) => [violation.metric, violation]));
  const metrics = [...firstByMetric.keys()];
  for (const metric of secondByMetric.keys()) {
    if (!firstByMetric.has(metric)) metrics.push(metric);
  }
  return metrics.slice(0, MAX_VIOLATIONS * 2).map((metric) => {
    const first = firstByMetric.get(metric);
    const second = secondByMetric.get(metric);
    const policy = RUNTIME_MATERIALITY_POLICIES.get(metric);
    const repeated = first !== undefined && second !== undefined;
    const material = repeated
      && first.measured > policy.materialThreshold
      && second.measured > policy.materialThreshold;
    return {
      metric,
      category: policy.category,
      classification: material ? "material" : "advisory",
      reason: !repeated
        ? "not_repeated"
        : material
          ? "repeated_material_threshold"
          : "below_material_threshold",
      budget: policy.budget,
      relativeExcessRatio: RELATIVE_EXCESS_RATIO,
      minimumExcess: policy.minimumExcess,
      materialThreshold: policy.materialThreshold,
      firstMeasured: first?.measured ?? null,
      secondMeasured: second?.measured ?? null,
    };
  });
}

function runtimeMaterialityPolicies(runtimeBudgets) {
  const policies = new Map();
  addProfilePolicies(policies, runtimeBudgets.coldHubReadyMs, {
    category: "cold_readiness_ms",
    metricName: "coldHubReadyMs",
    minimumExcess: 100,
  });
  addProfilePolicies(policies, runtimeBudgets.idleRssBytes, {
    category: "rss_bytes",
    metricName: "idleRssBytes",
    minimumExcess: 32 * MIB,
  });
  addProfilePolicies(policies, runtimeBudgets.idleCpuMs, {
    category: "idle_cpu_ms",
    metricName: "idleCpuMs",
    minimumExcess: 25,
  });
  addNestedPolicies(policies, runtimeBudgets.apiLatencyMs, {
    category: "api_latency_ms",
    metricName: "apiLatencyMs",
    minimumExcess: 15,
  });
  addNestedPolicies(policies, runtimeBudgets.maintenanceMs, {
    category: "maintenance_ms",
    metricName: "maintenanceMs",
    minimumExcess: 50,
  });
  addNestedPolicies(policies, runtimeBudgets.maintenancePeakRssBytes, {
    category: "rss_bytes",
    metricName: "maintenancePeakRssBytes",
    minimumExcess: 32 * MIB,
  });
  addNestedPolicies(policies, runtimeBudgets.browserHeapBytes, {
    category: "browser_heap_bytes",
    metricName: "browserHeapBytes",
    minimumExcess: 2 * MIB,
  });
  return policies;
}

function addProfilePolicies(policies, budgetsForMetric, definition) {
  for (const [profile, budget] of Object.entries(budgetsForMetric ?? {})) {
    addPolicy(policies, `runtime.${definition.metricName}.${profile}`, budget, definition);
  }
}

function addNestedPolicies(policies, budgetsForMetric, definition) {
  for (const [profile, entries] of Object.entries(budgetsForMetric ?? {})) {
    for (const [name, budget] of Object.entries(entries)) {
      addPolicy(
        policies,
        `runtime.${definition.metricName}.${profile}.${name}`,
        budget,
        definition,
      );
    }
  }
}

function addPolicy(policies, metric, budget, definition) {
  const minimumExcess = definition.minimumExcess;
  policies.set(metric, Object.freeze({
    budget,
    category: definition.category,
    minimumExcess,
    materialThreshold: budget + Math.max(budget * RELATIVE_EXCESS_RATIO, minimumExcess),
  }));
}
