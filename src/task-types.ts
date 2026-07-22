export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskWorkflowLink {
  loopId: string;
  stateId: string;
  transitionSeq: number;
}

export interface TaskEntry {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
  workflow?: TaskWorkflowLink;
}

export interface TaskStoreData {
  nextId: number;
  tasks: TaskEntry[];
}
