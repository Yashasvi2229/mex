export const SIX_ARM_ORDERS = Object.freeze([
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
]);

/** Deterministic balanced order. With six tasks, every permutation appears once. */
export function buildSchedule(tasks, armIds) {
  if (armIds.length !== 3) throw new Error("comparison schedule requires exactly three arms");
  return tasks.flatMap((task, taskIndex) => SIX_ARM_ORDERS[taskIndex % SIX_ARM_ORDERS.length].map((armIndex, orderIndex) => ({
    runId: `${String(taskIndex + 1).padStart(2, "0")}-${task.id}-${armIds[armIndex]}`,
    taskIndex,
    orderIndex,
    task,
    armId: armIds[armIndex],
  })));
}
