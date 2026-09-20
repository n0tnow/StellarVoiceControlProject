/**
 * Pure model for the notch Tasks page's "New schedule" form.
 *
 * The form is deliberately small (To / Amount / Every / First run) and maps to
 * the existing `@/lib/schedules` draft + intent, so a typed schedule and a
 * spoken one go through the same approval pipeline. Recipients are saved
 * contacts only: the chain tool refuses raw `G…` addresses, so a pasted address
 * is matched to its contact or refused with one sentence.
 */
import type { Intent } from "@polaris/interfaces";

import type { Contact } from "../../lib/contactsModel.ts";
import { buildScheduleForm, type RepeatChoice, type ScheduleForm } from "../../lib/schedules.ts";

/** The repeats the chain can represent; monthly repeats are not supported. */
export type ScheduleEvery = "once" | "day" | "week";

/** Payments in a repeating schedule (the chain needs a finite run count). */
export const REPEAT_RUNS = "8";

export interface SimpleScheduleInput {
  to: string;
  amount: string;
  every: ScheduleEvery;
  /** `datetime-local` value: `YYYY-MM-DDTHH:mm`. */
  firstRun: string;
  timeZone: string;
}

export interface SimpleSchedule {
  form: ScheduleForm;
  intent: Intent;
  /** One-line plain-language summary shown before Create. */
  readBack: string;
}

export type SimpleScheduleResult =
  | { ok: true; schedule: SimpleSchedule }
  | { ok: false; error: string };

/** A 56-char `G...` StrKey shape; the chain layer checks the checksum. */
const ADDRESS_SHAPE = /^G[A-Z2-7]{55}$/;

/** The saved contact a typed name (or pasted address) refers to, if any. */
export function resolveRecipientAlias(
  to: string,
  contacts: readonly Contact[],
): { ok: true; alias: string } | { ok: false; error: string } {
  const value = to.trim();
  if (value.length === 0) return { ok: false, error: "Enter a contact name." };
  const lower = value.toLowerCase();
  const byName = contacts.find((contact) => contact.nickname.toLowerCase() === lower);
  if (byName) return { ok: true, alias: byName.nickname };
  const byAddress = contacts.find((contact) => contact.address === value);
  if (byAddress) return { ok: true, alias: byAddress.nickname };
  if (ADDRESS_SHAPE.test(value)) {
    return { ok: false, error: "Raw addresses aren't accepted — save it as a contact first." };
  }
  return { ok: true, alias: lower };
}

/** Splits a `datetime-local` value into the date/time the draft expects. */
export function splitFirstRun(value: string): { date: string; time: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value.trim());
  return match ? { date: match[1]!, time: match[2]! } : null;
}

/** Tomorrow at 09:00 local, as a `datetime-local` default. */
export function defaultFirstRun(now: Date = new Date()): string {
  const next = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T09:00`;
}

function readBack(every: ScheduleEvery, form: ScheduleForm): string {
  const first = `${form.date} ${form.time}`;
  if (every === "once") return `${form.amount} XLM to ${form.recipient}, once on ${first}.`;
  return `${form.amount} XLM to ${form.recipient} every ${every}, starting ${first} (${form.runs} payments).`;
}

/** Validates the small form and builds the shared schedule draft + intent. */
export function buildSimpleSchedule(
  input: SimpleScheduleInput,
  contacts: readonly Contact[],
): SimpleScheduleResult {
  const recipient = resolveRecipientAlias(input.to, contacts);
  if (!recipient.ok) return recipient;
  const firstRun = splitFirstRun(input.firstRun);
  if (!firstRun) return { ok: false, error: "Pick the first run date and time." };

  const repeat: RepeatChoice = input.every === "once" ? "none" : input.every;
  const form: ScheduleForm = {
    recipient: recipient.alias,
    amount: input.amount.trim(),
    asset: "XLM",
    date: firstRun.date,
    time: firstRun.time,
    timeZone: input.timeZone,
    repeat,
    runs: repeat === "none" ? "" : REPEAT_RUNS,
  };
  const built = buildScheduleForm(form);
  if (!built.ok) return built;
  return { ok: true, schedule: { form, intent: built.intent, readBack: readBack(input.every, form) } };
}
