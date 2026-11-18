// Result folder format, shared by the agent job (writes it) and the comment job (checks it).
import { lstatSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Check = {
  claim: string;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  screenshots: string[];
};

export type Result = {
  pr: number;
  repo: string;
  runner: string;
  model: string;
  instruction: string;
  outcome: 'pass' | 'fail' | 'mixed' | 'no_result';
  checks: Check[];
  notes: string;
};

const MEDIA = /^media\/[\w.-]+\.png$/;
const MAX_CHECKS = 50;
// rvp's own limit: each image becomes a commit on the media branch, and this folder is untrusted
const MAX_MEDIA = 40;
const MAX_BYTES = 10 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;]*m/g;

export function outcome(checks: Check[]): Result['outcome'] {
  const passed = checks.filter(c => c.status === 'passed').length;
  const failed = checks.filter(c => c.status === 'failed').length;
  if (passed + failed === 0) return 'no_result';
  return failed === 0 ? 'pass' : passed === 0 ? 'fail' : 'mixed';
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** Agent job, last step: always leaves a result.json, even when the agent produced nothing. */
export function finish(outDir: string, env: Record<string, string | undefined>): Result {
  // checks.json is written by the session tool (agent/kit/pd.mjs) each time the agent records a verdict
  let checks: Check[] = [];
  try {
    checks = (JSON.parse(read(join(outDir, 'checks.json')) ?? '[]') as any[])
      .filter(c => typeof c?.claim === 'string' && ['passed', 'failed', 'skipped'].includes(c.status))
      .slice(0, MAX_CHECKS)
      .map(c => ({
        claim: c.claim.slice(0, 300),
        status: c.status,
        ...(typeof c.reason === 'string' ? { reason: c.reason.replace(ANSI, '').slice(0, 2000) } : {}),
        screenshots: (Array.isArray(c.screenshots) ? c.screenshots : []).filter((f: unknown) => typeof f === 'string' && MEDIA.test(f)),
      }));
  } catch {
    // unreadable file: same as no check
  }
  const notes =
    read(join(outDir, 'notes.md')) ??
    (checks.length ? '' : `No check was produced. End of the agent log:\n${(read(join(outDir, 'agent.log')) ?? '').slice(-1500)}`);
  const result: Result = {
    pr: Number(env.RVP_PR),
    repo: env.RVP_REPO ?? '',
    runner: env.RVP_RUNNER ?? '',
    model: env.RVP_MODEL ?? '',
    instruction: env.RVP_INSTRUCTION ?? '',
    outcome: outcome(checks),
    checks,
    notes: notes.replace(ANSI, '').slice(0, 4000),
  };
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

const PNG = [0x89, 0x50, 0x4e, 0x47];

function checkMedia(outDir: string, rel: unknown): string {
  if (typeof rel !== 'string' || !MEDIA.test(rel)) throw new Error(`bad media path: ${String(rel)}`);
  const path = join(outDir, rel);
  const stat = lstatSync(path); // lstat: a symlink is not a regular file, so it is refused
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`bad media file: ${rel}`);
  const head = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  if (!PNG.every((byte, i) => head[i] === byte)) throw new Error(`not a png: ${rel}`);
  return rel;
}

/** Comment job: the folder comes from a job that ran untrusted code, so nothing in it is taken on trust. */
export function check(outDir: string): Result {
  const raw = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'));
  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string') throw new Error(`${name} must be a string`);
    return v;
  };
  if (!['pass', 'fail', 'mixed', 'no_result'].includes(raw.outcome)) throw new Error('bad outcome');
  if (!Array.isArray(raw.checks) || raw.checks.length > MAX_CHECKS) throw new Error('bad checks');
  let mediaCount = 0;
  const checks: Check[] = raw.checks.map((c: any) => {
    if (!['passed', 'failed', 'skipped'].includes(c.status)) throw new Error('bad check status');
    if (!Array.isArray(c.screenshots)) throw new Error('bad screenshots');
    const screenshots = c.screenshots.map((s: unknown) => checkMedia(outDir, s));
    mediaCount += screenshots.length;
    return {
      claim: str(c.claim, 'claim'),
      status: c.status,
      ...(c.reason === undefined ? {} : { reason: str(c.reason, 'reason') }),
      screenshots,
    };
  });
  if (mediaCount > MAX_MEDIA) throw new Error(`too many media files (${mediaCount} > ${MAX_MEDIA})`);
  return {
    pr: Number(raw.pr),
    repo: str(raw.repo, 'repo'),
    runner: str(raw.runner, 'runner'),
    model: str(raw.model, 'model'),
    instruction: str(raw.instruction, 'instruction'),
    outcome: raw.outcome,
    checks,
    notes: str(raw.notes, 'notes'),
  };
}
