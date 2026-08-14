export function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("extension ctx is stale");
}
