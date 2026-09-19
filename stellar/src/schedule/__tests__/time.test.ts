import { describe, expect, it } from "vitest";
import { formatInZone, intervalWords, isValidTimeZone, resolveLocalTime } from "../time.ts";
import { syncRefusal } from "./helpers.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const base = { now: NOW, minLeadSeconds: 60 };

describe("resolveLocalTime — zones without surprises", () => {
  it("converts Istanbul local time (UTC+03, no DST) to UTC epoch seconds", () => {
    const r = resolveLocalTime({ localDate: "2026-09-20", localTime: "15:00", timeZone: "Europe/Istanbul", ...base });
    expect(r.epochSeconds).toBe(Date.UTC(2026, 8, 20, 12, 0, 0) / 1000);
    expect(r.utcIso).toBe("2026-09-20T12:00:00.000Z");
    expect(r.localIso).toBe("2026-09-20T15:00:00+03:00");
    expect(r.offsetMinutes).toBe(180);
    expect(r.ambiguous).toBe(false);
  });

  it("treats a spring-forward wall time as valid in Istanbul (no DST since 2016)", () => {
    const r = resolveLocalTime({ localDate: "2026-03-29", localTime: "02:30", timeZone: "Europe/Istanbul", ...base });
    expect(r.offsetMinutes).toBe(180);
    expect(r.ambiguous).toBe(false);
    expect(r.utcIso).toBe("2026-03-28T23:30:00.000Z");
  });

  it("handles the half-hour offset of Asia/Kolkata (+05:30)", () => {
    const r = resolveLocalTime({ localDate: "2026-09-20", localTime: "15:00", timeZone: "Asia/Kolkata", ...base });
    expect(r.offsetMinutes).toBe(330);
    expect(r.utcIso).toBe("2026-09-20T09:30:00.000Z");
    expect(r.localIso).toBe("2026-09-20T15:00:00+05:30");
  });

  it("handles UTC (zero offset)", () => {
    const r = resolveLocalTime({ localDate: "2026-09-20", localTime: "15:00", timeZone: "UTC", ...base });
    expect(r.offsetMinutes).toBe(0);
    expect(r.utcIso).toBe("2026-09-20T15:00:00.000Z");
    expect(r.localIso).toBe("2026-09-20T15:00:00+00:00");
  });

  it("uses Berlin summer time (+02:00)", () => {
    const r = resolveLocalTime({ localDate: "2026-07-01", localTime: "12:00", timeZone: "Europe/Berlin", ...base });
    expect(r.offsetMinutes).toBe(120);
    expect(r.utcIso).toBe("2026-07-01T10:00:00.000Z");
  });

  it("uses Berlin winter time (+01:00)", () => {
    const r = resolveLocalTime({ localDate: "2026-01-15", localTime: "12:00", timeZone: "Europe/Berlin", ...base });
    expect(r.offsetMinutes).toBe(60);
    expect(r.utcIso).toBe("2026-01-15T11:00:00.000Z");
  });

  it("uses New York summer time (-04:00)", () => {
    const r = resolveLocalTime({ localDate: "2026-07-01", localTime: "12:00", timeZone: "America/New_York", ...base });
    expect(r.offsetMinutes).toBe(-240);
    expect(r.utcIso).toBe("2026-07-01T16:00:00.000Z");
  });

  it("uses New York winter time (-05:00)", () => {
    const r = resolveLocalTime({ localDate: "2026-01-15", localTime: "12:00", timeZone: "America/New_York", ...base });
    expect(r.offsetMinutes).toBe(-300);
    expect(r.utcIso).toBe("2026-01-15T17:00:00.000Z");
  });
});

describe("resolveLocalTime — DST spring-forward gap", () => {
  it("refuses a non-existent Berlin time with the two nearest valid times", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "2026-03-29", localTime: "02:30", timeZone: "Europe/Berlin", ...base }),
    );
    expect(err.code).toBe("time_does_not_exist");
    const before = err.details?.before as { localIso: string };
    const after = err.details?.after as { localIso: string };
    expect(before.localIso).toBe("2026-03-29T01:59:59+01:00");
    expect(after.localIso).toBe("2026-03-29T03:00:00+02:00");
  });

  it("refuses a non-existent New York time (2026-03-08 02:30)", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "2026-03-08", localTime: "02:30", timeZone: "America/New_York", ...base }),
    );
    expect(err.code).toBe("time_does_not_exist");
    const before = err.details?.before as { localIso: string };
    const after = err.details?.after as { localIso: string };
    expect(before.localIso).toBe("2026-03-08T01:59:59-05:00");
    expect(after.localIso).toBe("2026-03-08T03:00:00-04:00");
  });

  it("accepts the first valid instant after the Berlin gap", () => {
    const r = resolveLocalTime({ localDate: "2026-03-29", localTime: "03:00", timeZone: "Europe/Berlin", ...base });
    expect(r.offsetMinutes).toBe(120);
    expect(r.utcIso).toBe("2026-03-29T01:00:00.000Z");
  });
});

describe("resolveLocalTime — DST fall-back overlap", () => {
  it("picks the earlier Berlin instant and flags ambiguity", () => {
    const r = resolveLocalTime({ localDate: "2026-10-25", localTime: "02:30", timeZone: "Europe/Berlin", ...base });
    expect(r.ambiguous).toBe(true);
    expect(r.epochSeconds).toBe(Date.UTC(2026, 9, 25, 0, 30, 0) / 1000);
    expect(r.utcIso).toBe("2026-10-25T00:30:00.000Z");
    expect(r.offsetMinutes).toBe(120);
    expect(r.localIso).toBe("2026-10-25T02:30:00+02:00");
  });

  it("picks the earlier New York instant and flags ambiguity", () => {
    const r = resolveLocalTime({ localDate: "2026-11-01", localTime: "01:30", timeZone: "America/New_York", ...base });
    expect(r.ambiguous).toBe(true);
    expect(r.epochSeconds).toBe(Date.UTC(2026, 10, 1, 5, 30, 0) / 1000);
    expect(r.offsetMinutes).toBe(-240);
  });
});

describe("resolveLocalTime — past and lead time", () => {
  it("refuses a time in the past", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "2025-09-18", localTime: "15:00", timeZone: "Europe/Istanbul", ...base }),
    );
    expect(err.code).toBe("time_in_past");
  });

  it("refuses a time within minLeadSeconds of now", () => {
    const firstRunEpoch = Date.UTC(2026, 8, 20, 12, 0, 0) / 1000;
    const err = syncRefusal(() =>
      resolveLocalTime({
        localDate: "2026-09-20",
        localTime: "15:00",
        timeZone: "Europe/Istanbul",
        now: new Date(firstRunEpoch * 1000 - 30_000),
        minLeadSeconds: 60,
      }),
    );
    expect(err.code).toBe("time_in_past");
    expect(err.details?.minLeadSeconds).toBe(60);
  });

  it("accepts a time exactly minLeadSeconds in the future", () => {
    const firstRunEpoch = Date.UTC(2026, 8, 20, 12, 0, 0) / 1000;
    const r = resolveLocalTime({
      localDate: "2026-09-20",
      localTime: "15:00",
      timeZone: "Europe/Istanbul",
      now: new Date(firstRunEpoch * 1000 - 60_000),
      minLeadSeconds: 60,
    });
    expect(r.epochSeconds).toBe(firstRunEpoch);
  });
});

describe("resolveLocalTime — invalid input (never a raw TypeError)", () => {
  it("refuses an invalid IANA zone", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "2026-09-20", localTime: "15:00", timeZone: "Mars/Olympus", ...base }),
    );
    expect(err.code).toBe("invalid_time");
  });

  it("refuses a non-existent calendar date", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "2026-02-30", localTime: "15:00", timeZone: "UTC", ...base }),
    );
    expect(err.code).toBe("invalid_time");
  });

  it("refuses an out-of-range time", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "2026-09-20", localTime: "25:00", timeZone: "UTC", ...base }),
    );
    expect(err.code).toBe("invalid_time");
  });

  it("refuses a malformed localDate", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "20-09-2026", localTime: "15:00", timeZone: "UTC", ...base }),
    );
    expect(err.code).toBe("invalid_time");
  });

  it("refuses null input", () => {
    const err = syncRefusal(() => resolveLocalTime(null as never));
    expect(err.code).toBe("invalid_time");
  });

  it("refuses a negative minLeadSeconds", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "2026-09-20", localTime: "15:00", timeZone: "UTC", now: NOW, minLeadSeconds: -1 }),
    );
    expect(err.code).toBe("invalid_time");
  });

  it("refuses an invalid now", () => {
    const err = syncRefusal(() =>
      resolveLocalTime({ localDate: "2026-09-20", localTime: "15:00", timeZone: "UTC", now: new Date("nope") }),
    );
    expect(err.code).toBe("invalid_time");
  });
});

describe("formatInZone and intervalWords", () => {
  it("formats a UTC instant in a half-hour zone", () => {
    const epoch = Date.UTC(2026, 8, 20, 12, 0, 0) / 1000;
    expect(formatInZone(epoch, "Asia/Kolkata")).toBe("2026-09-20T17:30:00+05:30");
  });

  it("formats a UTC instant in UTC", () => {
    const epoch = Date.UTC(2026, 8, 20, 12, 0, 0) / 1000;
    expect(formatInZone(epoch, "UTC")).toBe("2026-09-20T12:00:00+00:00");
  });

  it("refuses an invalid zone in formatInZone", () => {
    const err = syncRefusal(() => formatInZone(0, "Nowhere/Here"));
    expect(err.code).toBe("invalid_time");
  });

  it("renders interval seconds in words", () => {
    expect(intervalWords(0)).toBe("one-shot (no repeat)");
    expect(intervalWords(60)).toBe("every minute");
    expect(intervalWords(120)).toBe("every 2 minutes");
    expect(intervalWords(3600)).toBe("every hour");
    expect(intervalWords(7200)).toBe("every 2 hours");
    expect(intervalWords(86_400)).toBe("every day");
    expect(intervalWords(172_800)).toBe("every 2 days");
    expect(intervalWords(604_800)).toBe("every week");
    expect(intervalWords(1_209_600)).toBe("every 2 weeks");
    expect(intervalWords(90)).toBe("every 90 seconds");
  });

  it("validates IANA zone names", () => {
    expect(isValidTimeZone("Europe/Istanbul")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Nope/Nope")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
