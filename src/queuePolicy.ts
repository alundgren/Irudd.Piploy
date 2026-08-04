export type QueueSource = "client" | "timer";

export type QueueAdmission = "enqueue" | "reject-busy" | "drop";

/**
 * Decides what to do with one item before it enters the daemon's bounded
 * queue. Client requests must get an answer; a periodic tick can disappear.
 */
export function decideQueueAdmission(
  queueLength: number,
  capacity: number,
  source: QueueSource,
): QueueAdmission {
  if (queueLength < capacity) return "enqueue";
  return source === "client" ? "reject-busy" : "drop";
}
