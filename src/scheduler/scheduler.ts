import { log } from "../logger.js";

/**
 * Scheduler abstraction. The default runs jobs in-process with setInterval and never lets
 * a job overlap itself. To run on an external cron instead (Render cron job, GitHub Actions,
 * cron-job.org...), set ENABLE_IN_PROCESS_SCHEDULER=false and call POST /internal/tick.
 */
export interface Scheduler {
  every(name: string, intervalMs: number, job: () => Promise<unknown>): void;
  /** Run a one-off job after a delay, replacing any pending job with the same key (debounce). */
  debounce(key: string, delayMs: number, job: () => Promise<unknown>): void;
  stop(): void;
}

export class InProcessScheduler implements Scheduler {
  private intervals: NodeJS.Timeout[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();

  every(name: string, intervalMs: number, job: () => Promise<unknown>) {
    const run = async () => {
      if (this.running.has(name)) return;
      this.running.add(name);
      try {
        await job();
      } catch (err) {
        log.error("scheduled job failed", { name, err });
      } finally {
        this.running.delete(name);
      }
    };
    this.intervals.push(setInterval(run, intervalMs));
    log.info("scheduled job", { name, everyMinutes: Math.round(intervalMs / 60000) });
  }

  debounce(key: string, delayMs: number, job: () => Promise<unknown>) {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        job().catch((err) => log.error("debounced job failed", { key, err }));
      }, delayMs),
    );
  }

  stop() {
    this.intervals.forEach(clearInterval);
    this.timers.forEach(clearTimeout);
    this.intervals = [];
    this.timers.clear();
  }
}

/** Scheduler that does nothing on its own (external cron mode / tests). */
export class ManualScheduler implements Scheduler {
  every() {}
  debounce() {}
  stop() {}
}
