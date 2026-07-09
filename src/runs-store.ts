// Persistence for run results. Every run is one JSONL line under a fixed
// ./runs/ directory — never an arbitrary path from input. Stores the raw arrays
// needed to answer analyze_run / get_series later, keyed by a stable runId.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from './engine-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project-root/runs, resolved from this module's location (not process.cwd()).
const RUNS_DIR = path.resolve(__dirname, '..', 'runs');
const RUNS_FILE = path.join(RUNS_DIR, 'runs.jsonl');

const RUN_ID_RE = /^r-\d{6}$/;

export interface StoredRun {
  runId: string;
  ts: number;
  scenario: string;
  params?: unknown;
  result: RunResult;
}

export class RunsStore {
  private counter = 0;

  constructor() {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    this.counter = this.loadMaxCounter();
  }

  private loadMaxCounter(): number {
    if (!fs.existsSync(RUNS_FILE)) return 0;
    let max = 0;
    for (const line of fs.readFileSync(RUNS_FILE, 'utf-8').split('\n')) {
      const m = line.match(/"runId":"r-(\d+)"/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  }

  nextRunId(): string {
    this.counter++;
    return 'r-' + String(this.counter).padStart(6, '0');
  }

  append(run: StoredRun): void {
    fs.appendFileSync(RUNS_FILE, JSON.stringify(run) + '\n');
  }

  private readAll(): StoredRun[] {
    if (!fs.existsSync(RUNS_FILE)) return [];
    return fs
      .readFileSync(RUNS_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StoredRun);
  }

  /** Most recent first. */
  list(opts: { limit?: number; scenario?: string } = {}): StoredRun[] {
    const all = this.readAll().filter((r) => !opts.scenario || r.scenario === opts.scenario);
    const limit = Math.max(1, Math.floor(opts.limit ?? 20));
    return all.slice(-limit).reverse();
  }

  /** Validates runId format before any lookup; returns null on bad format or miss. */
  get(runId: string): StoredRun | null {
    if (!RUN_ID_RE.test(runId)) return null;
    const all = this.readAll();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].runId === runId) return all[i];
    }
    return null;
  }

  latest(): StoredRun | null {
    const all = this.readAll();
    return all.length ? all[all.length - 1] : null;
  }
}
