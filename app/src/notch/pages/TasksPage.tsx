/**
 * Scheduled Tasks page — recurring / one-shot agent jobs.
 *
 * Mirrors the guard's scheduler terminology (`next_run_at`, recurrence). The
 * enable toggle, delete button and "new task" row are all local state only —
 * mock wiring. A real `create_schedule` call replaces the state updates in a
 * follow-up task.
 */
import { useState, type FormEvent } from "react";
import { CalendarClock, Plus, Trash2 } from "lucide-react";

import {
  MOCK_SCHEDULED_TASKS,
  formatNextRun,
  type ScheduledTask,
} from "@/lib/mockData";

/** Cheap unique id for locally added mock tasks. */
let nextLocalId = 0;

export function TasksPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>(MOCK_SCHEDULED_TASKS);
  const [draft, setDraft] = useState("");

  const toggle = (id: string): void => {
    setTasks((current) =>
      current.map((task) =>
        task.id === id ? { ...task, enabled: !task.enabled } : task,
      ),
    );
  };

  const remove = (id: string): void => {
    setTasks((current) => current.filter((task) => task.id !== id));
  };

  // Mock scheduling: the row keeps the shape of the real flow (describe the
  // task in words, the agent turns it into a schedule) without calling one.
  const addTask = (event: FormEvent): void => {
    event.preventDefault();
    const description = draft.trim();
    if (!description) return;
    nextLocalId += 1;
    setTasks((current) => [
      {
        id: `local-${nextLocalId}`,
        schedule: "Not scheduled yet",
        recurrence: "once",
        description,
        enabled: true,
        nextRunAt: Math.floor(Date.now() / 1000),
      },
      ...current,
    ]);
    setDraft("");
  };

  return (
    <div className="page-stack">
      <form className="task-new" onSubmit={addTask}>
        <Plus className="task-new-icon" aria-hidden="true" />
        <input
          className="task-new-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder='New task, e.g. "every Friday — send 10 USDC to Alice"'
          aria-label="New scheduled task"
        />
      </form>
      <ul className="page-list task-list">
        {tasks.map((task) => (
          <li key={task.id} className={`task-row${task.enabled ? "" : " is-disabled"}`}>
            <button
              type="button"
              role="switch"
              aria-checked={task.enabled}
              aria-label={`${task.enabled ? "Disable" : "Enable"}: ${task.description}`}
              className={`page-toggle${task.enabled ? " is-on" : ""}`}
              onClick={() => toggle(task.id)}
            >
              <span className="page-toggle-knob" />
            </button>
            <span className="task-main">
              <span className="task-description">{task.description}</span>
              <span className="task-schedule">
                <CalendarClock aria-hidden="true" />
                {task.schedule} · next {formatNextRun(task.nextRunAt)}
              </span>
            </span>
            <button
              type="button"
              className="page-icon-button"
              aria-label={`Delete: ${task.description}`}
              onClick={() => remove(task.id)}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
