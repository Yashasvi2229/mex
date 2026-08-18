export const SIX_ARM_ORDERS = Object.freeze([
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
]);

/** Deterministic balanced order across matched task repetitions. */
export function buildSchedule(tasks, armIds, repetitions = 1) {
  if (armIds.length !== 3) throw new Error("comparison schedule requires exactly three arms");
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("repetitions must be a positive integer");
  return tasks.flatMap((task, taskIndex) => Array.from({ length: repetitions }, (_, repetitionIndex) => {
    const permutation = SIX_ARM_ORDERS[(taskIndex * repetitions + repetitionIndex) % SIX_ARM_ORDERS.length];
    return permutation.map((armIndex, orderIndex) => ({
      runId: `${String(taskIndex + 1).padStart(2, "0")}-${task.id}${repetitions > 1 ? `-r${String(repetitionIndex + 1).padStart(2, "0")}` : ""}-${armIds[armIndex]}`,
      taskIndex,
      repetition: repetitionIndex + 1,
      orderIndex,
      task,
      armId: armIds[armIndex],
    }));
  }).flat());
}
