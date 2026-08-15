export type TaskStatus = "pending" | "in_progress" | "completed" | "closed";

export interface TaskClaim {
  claimId: string;
  ownerSessionId: string;
  ownerRuntimeId: string;
  claimedAt: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
  attempt: number;
}

export interface TaskEntry {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  revision?: number;
  claim?: TaskClaim;
  completedAt?: number;
  reopenedAt?: number;
  closedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskStoreData {
  nextId: number;
  tasks: TaskEntry[];
}
