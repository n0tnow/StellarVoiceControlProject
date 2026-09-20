import assert from "node:assert/strict";
import { test } from "node:test";

import type { Contact } from "@/lib/contactsModel";

import {
  buildSimpleSchedule,
  defaultFirstRun,
  resolveRecipientAlias,
  splitFirstRun,
} from "./newSchedule.ts";

const ADA: Contact = { nickname: "ada", address: "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO" };
const BOB: Contact = { nickname: "bob", address: "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5" };

test("resolveRecipientAlias matches a saved name or address, and refuses raw addresses", () => {
  assert.deepEqual(resolveRecipientAlias("Ada", [ADA]), { ok: true, alias: "ada" });
  assert.deepEqual(resolveRecipientAlias(ADA.address, [ADA]), { ok: true, alias: "ada" });
  assert.equal(resolveRecipientAlias(BOB.address, [ADA]).ok, false);
  assert.deepEqual(resolveRecipientAlias("carol", [ADA]), { ok: true, alias: "carol" });
  assert.equal(resolveRecipientAlias("", [ADA]).ok, false);
});

test("splitFirstRun accepts only a datetime-local value", () => {
  assert.deepEqual(splitFirstRun("2026-09-25T10:00"), { date: "2026-09-25", time: "10:00" });
  assert.equal(splitFirstRun("2026-09-25"), null);
  assert.equal(splitFirstRun(""), null);
});

test("defaultFirstRun is tomorrow at 09:00 local", () => {
  assert.equal(defaultFirstRun(new Date(2026, 8, 20, 15, 30)), "2026-09-21T09:00");
});

test("buildSimpleSchedule builds a weekly schedule with a finite run count", () => {
  const result = buildSimpleSchedule(
    { to: "ada", amount: "5", every: "week", firstRun: "2026-09-25T10:00", timeZone: "Europe/Istanbul" },
    [ADA],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.schedule.form.recipient, "ada");
  assert.equal(result.schedule.form.repeat, "week");
  assert.equal(result.schedule.form.runs, "8");
  assert.equal(result.schedule.intent.kind, "schedule_payment");
  assert.equal(result.schedule.intent.asset, "XLM");
  assert.equal(result.schedule.intent.amount, "5");
  assert.match(result.schedule.readBack, /every week/);
});

test("buildSimpleSchedule makes a one-shot without a run count", () => {
  const result = buildSimpleSchedule(
    { to: "ada", amount: "3", every: "once", firstRun: "2026-09-25T10:00", timeZone: "UTC" },
    [ADA],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.schedule.form.repeat, "none");
  assert.equal(result.schedule.form.runs, "");
  assert.match(result.schedule.readBack, /once on/);
});

test("buildSimpleSchedule surfaces the amount validation", () => {
  const result = buildSimpleSchedule(
    { to: "ada", amount: "0", every: "day", firstRun: "2026-09-25T10:00", timeZone: "UTC" },
    [ADA],
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /positive/i);
});
