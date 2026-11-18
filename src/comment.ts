// Comment action: result folder -> PR comment. Never executes anything from the folder.
//   action:  inputs dir, repo, pr, token, media_token (see comment/action.yml)
//   local:   node comment/dist/index.mjs --dry-run <dir> [image-url-prefix]   (prints the body, no network)
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { check, type Result } from './result';

const ICON = { passed: '✅', failed: '❌', skipped: '⚪' } as const;
const HEAD = {
  pass: '✅ all checks passed',
  fail: '❌ checks failed',
  mixed: '⚠️ some checks failed',
  no_result: '⚠️ no result',
} as const;

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');

/** Untrusted text on one line: no mentions, no HTML, no markdown links or formatting. */
export const inline = (s: string, max = 300): string =>
  strip(s)
    .replace(/\s+/g, ' ')
    .slice(0, max)
    .replace(/[\\`*_[\]#|!~>]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/@/g, '@​');

/** Untrusted text in a code block it cannot break out of. */
export const block = (s: string, max: number, lang = ''): string =>
  `~~~~${lang}\n${strip(s).slice(0, max).replace(/~~~/g, '~~ ~')}\n~~~~`;

export function render(result: Result, url: (media: string) => string, runUrl: string, actions: string, plan = ''): string {
  const out: string[] = [
    `## rvp: ${HEAD[result.outcome]}`,
    '',
    `> ${inline(result.instruction, 600)}`,
    '',
    `Runner \`${inline(result.runner, 30)}\` · model \`${inline(result.model, 60)}\`${runUrl ? ` · [run, video and trace](${runUrl})` : ''}`,
  ];
  for (const c of result.checks) {
    out.push('', `### ${ICON[c.status]} ${inline(c.claim)}`);
    if (c.reason) out.push('', inline(c.reason, 600));
    out.push(...screenshots(c.screenshots, url));
  }
  if (plan.trim()) out.push('', '<details><summary>What the agent planned</summary>', '', block(plan, 3000), '', '</details>');
  if (result.notes.trim()) out.push('', '<details><summary>Agent notes</summary>', '', block(result.notes, 3000), '', '</details>');
  const steps = actions.split('\n').filter(line => line.trim()).slice(0, 80);
  if (steps.length) out.push('', '<details><summary>What the agent did</summary>', '', ...steps.map((step, i) => `${i + 1}. ${inline(step, 300)}`), '', '</details>');
  out.push(
    '',
    '<sub>A local model drove a build of this PR and recorded these verdicts itself. They are its judgement, not a proof: check the screenshots, the video and the action log before relying on them.</sub>',
  );
  return out.join('\n').slice(0, 60_000);
}

/**
 * One screenshot is up to four files: NN-what-it-shows[.before][.dark].png
 * (before = the app without the PR, dark = dark theme). They are shown together in one table.
 */
export function screenshots(files: string[], url: (media: string) => string): string[] {
  const groups = new Map<string, Record<string, string>>();
  for (const file of files) {
    const [, stem, before, dark] = /^(.*?)(\.before)?(\.dark)?\.png$/.exec(basename(file)) ?? [];
    if (!stem) continue;
    groups.set(stem, { ...groups.get(stem), [`${before ? 'Before' : 'After'} ${dark ? 'Dark' : 'Light'}`]: file });
  }
  const out: string[] = [];
  for (const [stem, group] of groups) {
    const caption = inline(stem.replace(/^\d+-/, '').replace(/-/g, ' '));
    const image = (key: string): string => (group[key] ? `![${caption}](${url(group[key])})` : '');
    const rows = ['Before', 'After'].filter(row => group[`${row} Light`] || group[`${row} Dark`]);
    const columns = ['Light', 'Dark'].filter(column => rows.some(row => group[`${row} ${column}`]));
    if (rows.length === 1 && columns.length === 1) {
      out.push('', image(`${rows[0]} ${columns[0]}`), `<sub>${caption}</sub>`);
      continue;
    }
    const label = rows.length > 1;
    out.push(
      '',
      `<sub>${caption}</sub>`,
      '',
      `|${label ? ' |' : ''} ${columns.join(' | ')} |`,
      `|${label ? '---|' : ''}${columns.map(() => '---').join('|')}|`,
      ...rows.map(row => `|${label ? ` ${row} |` : ''} ${columns.map(column => image(`${row} ${column}`)).join(' | ')} |`),
    );
  }
  return out;
}

const readText = (dir: string, file: string): string => {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return '';
  }
};

async function api(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'rvp' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${response.status} ${await response.text()}`), { status: response.status });
  return response.json();
}

// ponytail: screenshots are committed to a `media` branch of the repo running the workflow and linked by raw URL.
// Works for a public repo only; a private one needs another host for images.
async function uploadScreenshots(token: string, repo: string, dir: string, files: string[], runId: string): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (!files.length) return urls;
  try {
    await api(token, 'GET', `/repos/${repo}/git/ref/heads/media`);
  } catch (error: any) {
    if (error.status !== 404) throw error;
    const { default_branch } = await api(token, 'GET', `/repos/${repo}`);
    const head = await api(token, 'GET', `/repos/${repo}/git/ref/heads/${default_branch}`);
    await api(token, 'POST', `/repos/${repo}/git/refs`, { ref: 'refs/heads/media', sha: head.object.sha });
  }
  for (const file of files) {
    // one at a time: parallel writes to the same branch conflict
    const saved = await api(token, 'PUT', `/repos/${repo}/contents/${runId}/${basename(file)}`, {
      message: `rvp run ${runId}: ${basename(file)}`,
      branch: 'media',
      content: readFileSync(join(dir, file)).toString('base64'),
    });
    urls.set(file, saved.content.download_url);
  }
  return urls;
}

async function main(): Promise<void> {
  const dry = process.argv[2] === '--dry-run';
  const input = (name: string): string => process.env[`INPUT_${name.toUpperCase()}`] ?? '';
  const dir = dry ? process.argv[3] : input('dir');
  const result = check(dir);
  const actions = readText(dir, 'steps.log'); // one line per action, written by the session tool
  const plan = readText(dir, 'plan.md'); // written by the model before it starts
  if (dry) {
    const prefix = process.argv[4];
    console.log(render(result, media => (prefix ? prefix + basename(media) : media), '', actions, plan));
    return;
  }
  const { GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  const repo = input('repo');
  const pr = Number(input('pr'));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0) throw new Error('bad repo or pr input');
  const urls = await uploadScreenshots(input('media_token'), GITHUB_REPOSITORY!, dir, result.checks.flatMap(c => c.screenshots), GITHUB_RUN_ID!);
  const body = render(result, media => urls.get(media)!, `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`, actions, plan);
  // where to comment comes from the workflow inputs, never from result.json
  const comment = await api(input('token'), 'POST', `/repos/${repo}/issues/${pr}/comments`, { body });
  console.log(`commented: ${comment.html_url}`);
}

if (!process.env.BUN_TEST) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
