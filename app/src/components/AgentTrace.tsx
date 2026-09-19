import { describeIntent } from "@polaris/agent";
import type { AgentStage } from "@polaris/interfaces";

import { AGENT_MODEL, type AgentRun } from "@/lib/agent";

/**
 * The A2 demo surface: one compact line under the notch showing the transcript
 * and what the agent did with it.
 *
 * It deliberately lives *below* the shell, never inside it — the expanded notch's
 * centre column is the camera housing (no pixels) and the ears are too narrow for
 * the answer (see `notes.md`, 2026-09-19 A1). The overlay itself stays a pure
 * function of `capture_status`.
 */
export function AgentTrace({
  run,
  stage,
}: {
  run: AgentRun | null;
  stage: AgentStage | null;
}) {
  if (!run) {
    return null;
  }

  const transcript = run.ok ? run.outcome.transcript : run.failure.transcript;
  const latency = run.ok ? run.outcome.latencyMs : run.failure.latencyMs;

  return (
    <div className="agent-trace" role="status" aria-live="polite">
      <p className="agent-trace-hear" title={transcript}>
        “{transcript}”
      </p>
      {run.ok ? (
        run.outcome.intent ? (
          <p className="agent-trace-intent">
            <span className="agent-trace-tag">intent</span>
            {describeIntent(run.outcome.intent)}
            <span className="agent-trace-ms"> · {latency} ms</span>
          </p>
        ) : (
          <p className="agent-trace-answer" title={run.outcome.answer}>
            {run.outcome.answer}
          </p>
        )
      ) : (
        <p className="agent-trace-error" title={run.failure.detail}>
          <span className="agent-trace-tag">{run.failure.label}</span>
          {run.failure.detail}
        </p>
      )}
      <p className="agent-trace-model">
        {AGENT_MODEL}
        {stage ? ` · ${stage}` : ""}
      </p>
    </div>
  );
}
