// Display order of the sidebar: newest task first. View-only; `ViewState.tasks` keeps arrival order.

/** Indexes of `tasks`, newest first (`createdAt` desc, then `id` desc). Returns a new array. */
export function newestFirst(tasks: readonly { id: number; createdAt: number }[]): number[] {
  return tasks
    .map((_, i) => i)
    .sort((a, b) => tasks[b]!.createdAt - tasks[a]!.createdAt || tasks[b]!.id - tasks[a]!.id);
}
