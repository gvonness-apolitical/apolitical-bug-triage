/**
 * Utility functions for bug triage.
 */

/** Verbose logging flag - can be set at runtime */
let verboseLogging = false;

/**
 * Enable or disable verbose logging.
 */
export function setVerboseLogging(enabled: boolean): void {
  verboseLogging = enabled;
}

/**
 * Log a debug message (only shown when verbose logging is enabled).
 */
export function logDebug(message: string, ...args: unknown[]): void {
  if (verboseLogging) {
    console.debug(`[DEBUG] ${message}`, ...args);
  }
}

/**
 * Log a warning message.
 */
export function logWarn(message: string, ...args: unknown[]): void {
  console.warn(`[WARN] ${message}`, ...args);
}

/**
 * Check if a confidence level meets the minimum threshold.
 */
export function meetsConfidenceThreshold(
  actual: 'high' | 'medium' | 'low',
  minimum: string
): boolean {
  const levels = { high: 3, medium: 2, low: 1 };
  return levels[actual] >= (levels[minimum as keyof typeof levels] ?? 1);
}
