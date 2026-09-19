/**
 * Local wall-clock -> UTC epoch seconds, with explicit IANA timezone.
 *
 * Pure and dependency-free beyond `Intl`. The two hard cases are handled
 * explicitly (they are real for `Europe/Berlin` and `America/New_York`):
 *
 *  - **Spring-forward gap**: the local time does not exist. We refuse with
 *    `time_does_not_exist`, carrying the two nearest valid local times (the
 *    last instant before the jump and the first after it).
 *  - **Fall-back overlap**: the local time happens twice. We pick the
 *    **earlier** instant and set `ambiguous: true`; the summary must warn.
 *
 * `Intl` is the source of truth for offsets, so half-hour zones
 * (`Asia/Kolkata`, +05:30) and zones without DST (`Europe/Istanbul`) work
 * without any table of our own.
 */
import { ScheduleRefusal } from "./errors.ts";
import type { ResolvedLocalTime } from "./types.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

interface Input {
  localDate?: unknown;
  localTime?: unknown;
  timeZone?: unknown;
  now?: unknown;
  minLeadSeconds?: unknown;
}

function invalidTime(message: string, details?: Record<string, unknown>): ScheduleRefusal {
  return new ScheduleRefusal("invalid_time", message, details);
}

/** True when `Intl` accepts the zone name. Never throws. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let dtf = formatterCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, dtf);
  }
  return dtf;
}

/** The local wall clock in `timeZone` at `epochMs`, with seconds precision. */
function wallAt(timeZone: string, epochMs: number): Wall & { second: number } {
  const floored = Math.floor(epochMs / 1000) * 1000;
  const parts = formatterFor(timeZone).formatToParts(new Date(floored));
  const bag: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") bag[part.type] = Number(part.value);
  }
  return {
    year: bag.year as number,
    month: bag.month as number,
    day: bag.day as number,
    hour: bag.hour as number,
    minute: bag.minute as number,
    second: bag.second as number,
  };
}

/** Offset (local - UTC) in seconds at `epochMs`, always a whole second. */
function offsetSecondsAt(timeZone: string, epochMs: number): number {
  const floored = Math.floor(epochMs / 1000) * 1000;
  const wall = wallAt(timeZone, floored);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return (asUtc - floored) / 1000;
}

/** Every UTC instant whose local representation equals `wall` (0, 1 or 2). */
function possibleInstants(timeZone: string, wall: Wall): number[] {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  const offsets = new Set<number>();
  for (const probe of [asUtc - 86_400_000, asUtc, asUtc + 86_400_000]) {
    offsets.add(offsetSecondsAt(timeZone, probe));
  }
  const found = new Set<number>();
  for (const offset of offsets) {
    const candidate = asUtc - offset * 1000;
    const local = wallAt(timeZone, candidate);
    const matches =
      local.year === wall.year &&
      local.month === wall.month &&
      local.day === wall.day &&
      local.hour === wall.hour &&
      local.minute === wall.minute;
    if (matches && offsetSecondsAt(timeZone, candidate) === offset) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/** Locate the offset change bracketing `centerMs` (to the second). */
function findTransition(timeZone: string, centerMs: number): number | null {
  const span = 36 * 3600 * 1000;
  let lo = centerMs - span;
  let hi = centerMs + span;
  const before = offsetSecondsAt(timeZone, lo);
  if (before === offsetSecondsAt(timeZone, hi)) return null;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2 / 1000) * 1000;
    if (offsetSecondsAt(timeZone, mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function toLocalIso(wall: Wall & { second?: number }, offsetMinutes: number): string {
  const second = wall.second ?? 0;
  return (
    `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(second)}` +
    formatOffset(offsetMinutes)
  );
}

function parseWall(localDate: string, localTime: string): Wall {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const [hour, minute] = localTime.split(":").map(Number) as [number, number];
  if (month < 1 || month > 12) throw invalidTime(`month out of range in ${JSON.stringify(localDate)}`);
  if (hour > 23) throw invalidTime(`hour out of range in ${JSON.stringify(localTime)}`);
  if (minute > 59) throw invalidTime(`minute out of range in ${JSON.stringify(localTime)}`);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw invalidTime(`${JSON.stringify(localDate)} is not a real calendar date`);
  }
  return { year, month, day, hour, minute };
}

function coerceNow(now: unknown): Date {
  if (now === undefined || now === null) return new Date();
  const date = now instanceof Date ? now : new Date(now as string | number);
  if (Number.isNaN(date.getTime())) throw invalidTime(`"now" is not a valid date: ${JSON.stringify(now)}`);
  return date;
}

/**
 * Resolve a local date/time in an explicit IANA zone to the UTC instant the
 * contract stores. Refuses invalid input, non-existent local times (DST gap),
 * ambiguous local times are accepted (earlier instant + `ambiguous: true`),
 * and times in the past / within `minLeadSeconds`.
 */
export function resolveLocalTime(input: Input): ResolvedLocalTime {
  if (input === null || input === undefined || typeof input !== "object") {
    throw invalidTime(`time input must be an object, got ${JSON.stringify(input)}`);
  }
  const { localDate, localTime, timeZone } = input;
  if (typeof localDate !== "string" || !DATE_RE.test(localDate)) {
    throw invalidTime(`localDate must be "YYYY-MM-DD", got ${JSON.stringify(localDate)}`);
  }
  if (typeof localTime !== "string" || !TIME_RE.test(localTime)) {
    throw invalidTime(`localTime must be "HH:mm", got ${JSON.stringify(localTime)}`);
  }
  if (!isValidTimeZone(timeZone)) {
    throw invalidTime(`timeZone must be a valid IANA zone, got ${JSON.stringify(timeZone)}`);
  }
  const wall = parseWall(localDate, localTime);

  let minLeadSeconds = 60;
  if (input.minLeadSeconds !== undefined) {
    if (
      typeof input.minLeadSeconds !== "number" ||
      !Number.isFinite(input.minLeadSeconds) ||
      input.minLeadSeconds < 0
    ) {
      throw invalidTime(
        `minLeadSeconds must be a non-negative number, got ${JSON.stringify(input.minLeadSeconds)}`,
      );
    }
    minLeadSeconds = input.minLeadSeconds;
  }
  const now = coerceNow(input.now);

  const instants = possibleInstants(timeZone, wall);
  if (instants.length === 0) {
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
    const transition = findTransition(timeZone, asUtc);
    const beforeMs = transition !== null ? transition - 1000 : asUtc - 3600_000;
    const afterMs = transition !== null ? transition : asUtc + 3600_000;
    const beforeWall = wallAt(timeZone, beforeMs);
    const afterWall = wallAt(timeZone, afterMs);
    const before = {
      epochSeconds: Math.floor(beforeMs / 1000),
      localIso: toLocalIso(beforeWall, offsetSecondsAt(timeZone, beforeMs) / 60),
    };
    const after = {
      epochSeconds: Math.floor(afterMs / 1000),
      localIso: toLocalIso(afterWall, offsetSecondsAt(timeZone, afterMs) / 60),
    };
    throw new ScheduleRefusal(
      "time_does_not_exist",
      `${localDate} ${localTime} does not exist in ${timeZone} (daylight-saving jump); ` +
        `the nearest valid times are ${before.localIso} and ${after.localIso}`,
      { before, after },
    );
  }

  const epochMs = instants[0] as number;
  const epochSeconds = Math.floor(epochMs / 1000);
  const offsetMinutes = offsetSecondsAt(timeZone, epochMs) / 60;
  const ambiguous = instants.length > 1;

  if (epochSeconds < Math.floor(now.getTime() / 1000) + minLeadSeconds) {
    throw new ScheduleRefusal(
      "time_in_past",
      `first run ${localDate} ${localTime} (${timeZone}) is in the past or less than ` +
        `${minLeadSeconds}s in the future; pick a later time`,
      {
        epochSeconds,
        nowEpochSeconds: Math.floor(now.getTime() / 1000),
        minLeadSeconds,
      },
    );
  }

  return {
    epochSeconds,
    utcIso: new Date(epochSeconds * 1000).toISOString(),
    localIso: toLocalIso(wall, offsetMinutes),
    offsetMinutes,
    ambiguous,
  };
}

/**
 * Format a UTC instant in `timeZone` as local ISO-8601 with offset, e.g.
 * `2026-09-20T15:00:00+03:00`. Used by the "Upcoming payments" list.
 */
export function formatInZone(epochSeconds: number, timeZone: string): string {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) {
    throw invalidTime(`epochSeconds must be a finite number, got ${JSON.stringify(epochSeconds)}`);
  }
  if (!isValidTimeZone(timeZone)) {
    throw invalidTime(`timeZone must be a valid IANA zone, got ${JSON.stringify(timeZone)}`);
  }
  const ms = Math.floor(epochSeconds) * 1000;
  const wall = wallAt(timeZone, ms);
  return toLocalIso(wall, offsetSecondsAt(timeZone, ms) / 60);
}

function plural(n: number, unit: string): string {
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

/**
 * Render a fixed-second interval in words. `0` means one-shot. Monthly repeats
 * are not representable, so only seconds/minutes/hours/days/weeks appear.
 */
export function intervalWords(intervalSecs: number): string {
  if (typeof intervalSecs !== "number" || !Number.isFinite(intervalSecs) || intervalSecs < 0) {
    throw invalidTime(`interval seconds must be a non-negative number, got ${JSON.stringify(intervalSecs)}`);
  }
  if (intervalSecs === 0) return "one-shot (no repeat)";
  if (intervalSecs % 604_800 === 0) return plural(intervalSecs / 604_800, "week");
  if (intervalSecs % 86_400 === 0) return plural(intervalSecs / 86_400, "day");
  if (intervalSecs % 3600 === 0) return plural(intervalSecs / 3600, "hour");
  if (intervalSecs % 60 === 0) return plural(intervalSecs / 60, "minute");
  return plural(intervalSecs, "second");
}
