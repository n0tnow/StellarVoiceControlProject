/**
 * `@polaris/stellar` schedule namespace.
 *
 * Public surface:
 *   - `schedulePayment(deps)(draft)`  — unsigned `create_schedule` + decoded summary + warnings.
 *   - `cancelSchedule(deps)(request)` — unsigned `cancel_schedule` (light confirmation).
 *   - `listUpcoming(deps)(options)`   — "Upcoming payments" view models.
 *   - `resolveLocalTime` / `formatInZone` / `intervalWords` — explicit-timezone time helpers.
 *
 * The guard contract id is always a parameter (via the injected client), never
 * a constant here (decision D9).
 */
export { DEFAULT_POLL_SECONDS } from "./constants.ts";
export { MAX_SCHEDULES, schedulePayment } from "./schedulePayment.ts";
export { cancelSchedule } from "./cancelSchedule.ts";
export { listUpcoming } from "./listUpcoming.ts";
export { formatInZone, intervalWords, isValidTimeZone, resolveLocalTime } from "./time.ts";
export {
  ScheduleAmbiguous,
  ScheduleRefusal,
  isScheduleAmbiguous,
  isScheduleRefusal,
  type ScheduleCandidate,
  type ScheduleRefusalCode,
} from "./errors.ts";
export type {
  CancelScheduleResult,
  CancelScheduleTool,
  FirstRun,
  ListUpcomingOptions,
  ListUpcomingTool,
  Repeat,
  ResolvedLocalTime,
  ScheduleDeps,
  ScheduleDraft,
  SchedulePaymentResult,
  SchedulePaymentTool,
  UpcomingPayment,
} from "./types.ts";
