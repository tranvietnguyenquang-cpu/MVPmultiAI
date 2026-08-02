import type { TaskStatus } from "./types.js";

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  DRAFT: ["PENDING_APPROVAL", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "CANCELLED"],
  APPROVED: ["PENDING_APPROVAL", "QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["AWAITING_REVIEW", "AWAITING_USER_ACCEPTANCE", "FAILED", "BLOCKED", "CANCELLED"],
  AWAITING_REVIEW: ["REVIEW_FAILED", "AWAITING_USER_ACCEPTANCE", "FAILED", "CANCELLED"],
  REVIEW_FAILED: ["PENDING_APPROVAL", "BLOCKED", "CANCELLED"],
  AWAITING_USER_ACCEPTANCE: ["COMPLETED", "PENDING_APPROVAL", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["PENDING_APPROVAL", "BLOCKED", "CANCELLED"],
  CANCELLED: [],
  BLOCKED: ["PENDING_APPROVAL", "CANCELLED"]
});

export class InvalidTaskTransitionError extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) {
    super(`Task cannot transition from ${from} to ${to}.`);
    this.name = "InvalidTaskTransitionError";
  }
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new InvalidTaskTransitionError(from, to);
}

/** Milestone 1 deliberately exposes no transition that queues or runs work. */
export const MILESTONE_1_TRANSITIONS = Object.freeze([
  ["DRAFT", "PENDING_APPROVAL"],
  ["DRAFT", "CANCELLED"],
  ["PENDING_APPROVAL", "APPROVED"],
  ["PENDING_APPROVAL", "CANCELLED"]
] as const satisfies ReadonlyArray<readonly [TaskStatus, TaskStatus]>);
