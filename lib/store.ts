// Runs one invoice through the pipeline and records it in the database.
import { createRun, finishRun, loadMaster, loadRules, priorRuns, type NewRun } from "./db";
import { processInvoice } from "./pipeline";
import type { Decision, StreamEvent } from "./types";

export const newRunId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Returns the decision, or null when this email attachment was already processed. */
export async function runAndStore(run: NewRun, onEvent?: (e: StreamEvent) => void): Promise<Decision | null> {
  const created = await createRun(run);
  if (!created) return null;
  const events: StreamEvent[] = [];
  const emit = (e: StreamEvent) => { events.push(e); onEvent?.(e); };
  emit({ type: "run", id: run.id });
  try {
    const [master, prior, rules] = await Promise.all([loadMaster(), priorRuns(), loadRules()]);
    await processInvoice(run.pdf, run.fileName, prior, emit, { master, sender: run.sender, rules });
  } catch (err) {
    emit({ type: "decision", decision: "ERROR", headline: "System error: the run could not finish", action: "Retry the run." });
    emit({ type: "error", message: (err as Error).message.slice(0, 200) });
    emit({ type: "done", totalMs: 0 });
  }
  await finishRun(run.id, events);
  const d = events.filter((e) => e.type === "decision").pop();
  return d && d.type === "decision" ? d.decision : "ERROR";
}
