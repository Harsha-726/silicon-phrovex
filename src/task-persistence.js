// Coordinate device-local task creates so background reconciliation cannot
// submit the same task while the original POST is still in flight.
export function createTaskPersistenceCoordinator(create) {
  const pending = new Map();

  function persist(task) {
    if (!task?.id) return Promise.resolve(task);
    const existing = pending.get(task.id);
    if (existing) return existing;
    const operation = Promise.resolve()
      .then(() => create(task))
      .finally(() => {
        if (pending.get(task.id) === operation) pending.delete(task.id);
      });
    pending.set(task.id, operation);
    return operation;
  }

  return {
    persist,
    hasPending(id) { return pending.has(id); },
    size() { return pending.size; }
  };
}
