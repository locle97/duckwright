// The open modals, oldest first. Only the topmost one reacts to Escape.
const stack: number[] = [];
let nextId = 0;

/** Registers a modal as the topmost; returns its id. */
export function pushModal(): number {
  const id = ++nextId;
  stack.push(id);
  return id;
}

export function popModal(id: number): void {
  const i = stack.indexOf(id);
  if (i !== -1) stack.splice(i, 1);
}

export const isTopModal = (id: number): boolean => stack.length > 0 && stack[stack.length - 1] === id;
