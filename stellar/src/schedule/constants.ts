/**
 * Shared schedule-tool constants.
 *
 * Kept in their own module so `listUpcoming` (the due/delayed grader) and
 * `schedulePayment` can share the keeper poll interval without importing each
 * other.
 */

/** Default keeper poll interval (seconds); drives the due/delayed grading. */
export const DEFAULT_POLL_SECONDS = 15;
