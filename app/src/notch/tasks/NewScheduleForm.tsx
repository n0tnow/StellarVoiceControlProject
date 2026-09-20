/**
 * The notch Tasks page's compact "New schedule" form.
 *
 * To / Amount / Every / First run only. It validates through the pure
 * [`buildSimpleSchedule`] helper and hands the built draft to `onCreate`, which
 * pushes it through the shared approval pipeline. Repeating schedules get a
 * finite run count (`REPEAT_RUNS`) because the chain cannot represent an
 * open-ended repeat.
 */
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useContacts } from "@/notch/wallet/useContacts";

import {
  buildSimpleSchedule,
  defaultFirstRun,
  type ScheduleEvery,
  type SimpleSchedule,
} from "./newSchedule";

const LIST_ID = "polaris-schedule-recipients";

export interface NewScheduleFormProps {
  disabled: boolean;
  timeZone: string;
  /** Called with the validated schedule; the page runs the approval pipeline. */
  onCreate: (schedule: SimpleSchedule) => void;
}

export function NewScheduleForm({ disabled, timeZone, onCreate }: NewScheduleFormProps) {
  const { contacts, reload } = useContacts();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [every, setEvery] = useState<ScheduleEvery>("week");
  const [firstRun, setFirstRun] = useState(() => defaultFirstRun());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onChange = (): void => void reload();
    window.addEventListener("polaris:contacts-changed", onChange);
    return () => window.removeEventListener("polaris:contacts-changed", onChange);
  }, [reload]);

  const preview = useMemo(
    () => buildSimpleSchedule({ to, amount, every, firstRun, timeZone }, contacts),
    [to, amount, every, firstRun, timeZone, contacts],
  );

  const submit = (): void => {
    const result = buildSimpleSchedule({ to, amount, every, firstRun, timeZone }, contacts);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onCreate(result.schedule);
  };

  return (
    <section className="rule-card">
      <div style={{ display: "flex", gap: 8 }}>
        <label className="task-new" style={{ flex: 1 }}>
          <span className="rule-condition">To</span>
          <input
            className="task-new-input"
            list={LIST_ID}
            value={to}
            placeholder="Contact name"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <datalist id={LIST_ID}>
          {contacts.map((contact) => (
            <option key={contact.nickname} value={contact.nickname} />
          ))}
        </datalist>
        <label className="task-new" style={{ flex: 1 }}>
          <span className="rule-condition">Amount</span>
          <input
            className="task-new-input"
            inputMode="decimal"
            value={amount}
            placeholder="5"
            disabled={disabled}
            onChange={(event) => setAmount(event.target.value)}
          />
          <span className="rule-condition">XLM</span>
        </label>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <label className="task-new" style={{ flex: 1 }}>
          <span className="rule-condition">Every</span>
          <select
            className="task-new-input"
            value={every}
            disabled={disabled}
            onChange={(event) => setEvery(event.target.value as ScheduleEvery)}
          >
            <option value="once">One time</option>
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </label>
        <label className="task-new" style={{ flex: 1 }}>
          <span className="rule-condition">First run</span>
          <input
            type="datetime-local"
            className="task-new-input"
            value={firstRun}
            disabled={disabled}
            onChange={(event) => setFirstRun(event.target.value)}
          />
        </label>
      </div>

      {preview.ok ? <p className="rule-condition">{preview.schedule.readBack}</p> : null}
      {error !== null ? <p className="rule-condition">{error}</p> : null}

      <div className="rule-approval">
        <Button size="sm" disabled={disabled} onClick={submit}>
          {disabled ? "Creating…" : "Create"}
        </Button>
      </div>
    </section>
  );
}
