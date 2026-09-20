import assert from "node:assert/strict";
import { test } from "node:test";

import type { schedule } from "@polaris/stellar";

import {
  cancelIntentFor,
  rowsFromMock,
  rowsFromUpcoming,
  tasksSource,
  tasksViewState,
  type TaskRow,
} from "./useTasksData.ts";

function upcoming(over: Partial<schedule.UpcomingPayment> = {}): schedule.UpcomingPayment {
  return {
    id: 7,
    recipientAlias: "acc2",
    recipientAddress: "GACC2",
    asset: "XLM",
    amountRaw: "50000000",
    amount: "5",
    nextRunUtc: "2026-09-25T07:00:00.000Z",
    nextRunLocal: "2026-09-25T10:00:00+03:00",
    runsLeft: 8,
    intervalWords: "every week",
    status: "scheduled",
    ...over,
  };
}

test("rowsFromUpcoming adapts the view model and keeps the numeric id", () => {
  const [row] = rowsFromUpcoming([upcoming()]);
  assert.equal(row?.key, "s-7");
  assert.equal(row?.scheduleId, 7);
  assert.equal(row?.recipient, "acc2");
  assert.equal(row?.amountLabel, "5 XLM");
  assert.equal(row?.recurrence, "every week");
  assert.equal(row?.runsLeft, 8);
  assert.equal(row?.nextRunUtc, "2026-09-25T07:00:00.000Z");
  assert.equal(row?.status, "scheduled");
  assert.equal(row?.statusLabel, "Scheduled");
});

test("rowsFromUpcoming falls back to the raw address when no alias exists", () => {
  const [row] = rowsFromUpcoming([upcoming({ recipientAlias: null, status: "delayed" })]);
  assert.equal(row?.recipient, "GACC2");
  assert.match(row?.statusLabel ?? "", /keeper/);
});

test("rowsFromMock maps demo rows and marks them non-cancellable", () => {
  const [row] = rowsFromMock([
    {
      id: "t-009",
      schedule: "Every Monday at 09:00",
      recurrence: "weekly",
      description: "Check balance and report",
      enabled: true,
      nextRunAt: 1758435600,
    },
  ]);
  assert.equal(row?.key, "t-009");
  assert.equal(row?.scheduleId, null);
  assert.equal(row?.recipient, "Check balance and report");
  assert.equal(row?.amountLabel, "");
  assert.equal(row?.runsLeft, null);
  assert.equal(row?.nextRunUtc, new Date(1758435600 * 1000).toISOString());
  assert.equal(row?.status, "scheduled");
});

test("rowsFromMock marks a disabled task finished", () => {
  const [row] = rowsFromMock([
    {
      id: "t-010",
      schedule: "Daily",
      recurrence: "daily",
      description: "Paused job",
      enabled: false,
      nextRunAt: 1758435600,
    },
  ]);
  assert.equal(row?.status, "finished");
  assert.equal(row?.statusLabel, "Disabled");
});

test("tasksSource: live inside Tauri with an owner, never demo there", () => {
  assert.equal(tasksSource({ inTauri: true, ownerAddress: "GACC2" }), "live");
  assert.equal(tasksSource({ inTauri: true, ownerAddress: null }), "unconfigured");
  assert.equal(tasksSource({ inTauri: false, ownerAddress: "GACC2" }), "demo");
  assert.equal(tasksSource({ inTauri: false, ownerAddress: null }), "demo");
});

test("tasksViewState never shows a blank body", () => {
  // Cached rows win, even while a background refresh is in flight.
  assert.equal(tasksViewState({ loading: true, error: null, count: 2 }), "rows");
  assert.equal(tasksViewState({ loading: false, error: "rpc down", count: 1 }), "rows");
  // First read with no cache: a skeleton, never blank.
  assert.equal(tasksViewState({ loading: true, error: null, count: 0 }), "skeleton");
  // A failed first read shows the error; a healthy empty read shows empty.
  assert.equal(tasksViewState({ loading: false, error: "rpc down", count: 0 }), "error");
  assert.equal(tasksViewState({ loading: false, error: null, count: 0 }), "empty");
});

test("cancelIntentFor builds a cancel_schedule intent for a real row only", () => {
  const [real] = rowsFromUpcoming([upcoming()]);
  const intent = cancelIntentFor(real as TaskRow);
  assert.equal(intent?.kind, "cancel_schedule");
  assert.equal(intent?.scheduleId, 7);

  const [demo] = rowsFromMock([
    {
      id: "t-011",
      schedule: "Once",
      recurrence: "once",
      description: "Demo row",
      enabled: true,
      nextRunAt: 1758435600,
    },
  ]);
  assert.equal(cancelIntentFor(demo as TaskRow), null);
});
