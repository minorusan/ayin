/**
 * sentinaile — a standing instruction the agent carries out on a schedule.
 *
 * `/sentinaile check the CI and tell me if anything broke, every 10 minutes` does three things, and
 * the split between them is the whole design:
 *
 *   1. PLAN ONCE, with the model. A vague sentence becomes an explicit list of steps and an explicit
 *      schedule, written to `sentinaile_plan.md` where a human can read and edit it.
 *   2. RUN MANY TIMES, without the model deciding anything new. Each run is a fresh `ayin -p` shell
 *      handed the plan; it works, reports, and dies.
 *   3. SUPERVISE, in a process that owns no work of its own — it only decides *when*, and it persists
 *      that decision before acting on it.
 *
 * WHY A SEPARATE SHELL PER RUN, rather than a long-lived agent looping. A process that runs for days
 * accumulates context, leaks whatever it leaks, and holds a model authority nobody can see. A process
 * that lives for one task and exits has none of those problems, and its failure mode is "that run
 * failed" rather than "the sentinel has been quietly wrong since Tuesday". It also keeps requestId
 * attribution honest: each run is its own process with its own correlation id, so the backend's GPU
 * queue shows one entry per run and nothing shares a module-global with the interactive session.
 *
 * SURVIVING THE POWER CUT is not a feature here, it is the definition of the thing. A scheduler whose
 * state lives in memory is a scheduler that silently stops at the first reboot — and it stops without
 * telling anyone, which is worse than never having existed. Every decision is written to disk BEFORE
 * it is acted on, and the supervisor rebuilds itself from that file on boot.
 */

/** How often, and how many times. All three forms reduce to `due(now)` in `schedule.ts`. */
export interface Schedule {
  /** Earliest moment the first run may happen, ms epoch. Absent = as soon as armed. */
  startAt?: number;
  /** Seconds between runs. Absent = run once. */
  everySeconds?: number;
  /** Stop after this many completed runs. Absent = until stopped by hand. */
  maxRuns?: number;
}

/** One step the plan says to perform. Prose, because the executing shell is an agent, not a runner. */
export interface PlanStep {
  /** What to do, in one imperative line. */
  instruction: string;
  /** Why it is in the plan — kept so an edited plan stays readable months later. */
  rationale?: string;
}

/**
 * Everything needed to rebuild a sentinel from disk after a crash.
 *
 * `id` is stable across restarts and is what `/sentinaile` targets when replacing or stopping one.
 */
export interface SentinelState {
  id: string;
  /** The operator's original sentence, verbatim. The plan is derived; this is the intent. */
  request: string;
  /** Directory the runs execute in — a sentinel is about a place as much as a task. */
  cwd: string;
  schedule: Schedule;
  /** Path to the human-readable plan the runs are handed. */
  planPath: string;
  /** ms epoch. */
  createdAt: number;
  /** Completed runs so far. Persisted before each run is launched, never after. */
  runsDone: number;
  /** ms epoch of the last launch, or 0. */
  lastRunAt: number;
  /** ms epoch when the next run becomes due. Recomputed and persisted on every transition. */
  nextDueAt: number;
  /** PID of the currently executing run shell, when one is live. */
  runningPid?: number;
  /** Why it stopped, when it has. A stopped sentinel is kept on disk as a record, not deleted. */
  stoppedReason?: string;
  /** ms epoch it stopped. */
  stoppedAt?: number;
}

/** What the model returns from the planning call — validated before it is trusted. */
export interface PlanDraft {
  schedule: Schedule;
  steps: PlanStep[];
  /** One line naming what this sentinel is for, used as the plan file's title. */
  title: string;
}
