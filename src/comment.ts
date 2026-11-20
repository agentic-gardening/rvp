// Comment action: result folder -> PR comment. Never executes anything from the folder.
//   action:  inputs dir, repo, pr, token, media_token (see comment/action.yml)
//   local:   node comment/dist/index.mjs --dry-run <dir> [image-url-prefix]   (prints the body, no network)
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { check, type Result } from './result';

const ICON = { passed: '✅', failed: '❌', skipped: '⚠️' } as const;

/** The words of the whole run: the worst claim decides, and a claim nobody checked is not a verified one. */
const verdict = (result: Result): string => {
  const count = (status: string): number => result.checks.filter(c => c.status === status).length;
  const [passed, failed, skipped, all] = [count('passed'), count('failed'), count('skipped'), result.checks.length];
  if (failed) return `❌ **Not verified**: ${failed} of ${all} claim${all > 1 ? 's' : ''} ${failed > 1 ? 'do' : 'does'} not hold.`;
  if (!passed) return '⚠️ **Not checked**: the model gave no verdict.';
  if (skipped) return `⚠️ **Partially verified**: ${passed} of ${all} claims hold, ${skipped} could not be checked.`;
  return `✅ **Verified**: ${all === 1 ? 'the claim holds' : `${all} of ${all} claims hold`}.`;
};

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
  const overall = verdict(result);
  const out: string[] = [
    `## rvp: ${overall.split(':')[0].replace(/\*\*/g, '')}`,
    '',
    `Checked on ${inline(result.runner, 30)} with the build of this pull request running, by \`${inline(result.model, 60)}\`.`,
    '',
    `> ${inline(result.instruction, 600)}`,
  ];
  const skipped: string[] = [];
  result.checks.forEach((c, i) => {
    if (c.status === 'skipped') {
      skipped.push(`- ${inline(c.claim)}${c.reason ? `: ${inline(c.reason, 300)}` : ''}`, ...folded(groups(c.screenshots), url));
      return;
    }
    out.push('', `**${i + 1}. ${inline(c.claim)}** ${ICON[c.status]}`);
    if (c.reason) out.push('', inline(c.reason, 600));
    out.push(...pictures(c, url));
  });
  if (skipped.length) out.push('', '**Not checked:**', '', ...skipped);
  out.push('', '### Verdict', overall, ...result.checks.map(c => `- ${ICON[c.status]} ${inline(c.claim)}`));
  if (plan.trim()) out.push('', '<details><summary>What the agent planned</summary>', '', block(plan, 3000), '', '</details>');
  if (result.notes.trim()) out.push('', '<details><summary>Agent notes</summary>', '', block(result.notes, 3000), '', '</details>');
  const steps = actions.split('\n').filter(line => line.trim()).slice(0, 80);
  if (steps.length) out.push('', `<details><summary>What the agent did (${steps.length} steps)</summary>`, '', ...steps.map((step, i) => `${i + 1}. ${inline(step, 300)}`), '', '</details>');
  const run = /\/runs\/(\d+)/.exec(runUrl)?.[1];
  out.push(
    '',
    '---',
    `<sub>rvp · runner \`${inline(result.runner, 30)}\` · model \`${inline(result.model, 60)}\`${runUrl ? ` · [run ${run ?? ''} and result folder](${runUrl})` : ''}${(result.facts ?? []).map(fact => ` · ${inline(fact, 200)}`).join('')}</sub>`,
    '<sub>A local model drove a build of this pull request and recorded these verdicts itself. They are its judgement, not a proof: check the screenshots and the action log before relying on them.</sub>',
  );
  return out.join('\n').slice(0, 60_000);
}

type Group = { stem: string; caption: string; Light?: string; Dark?: string };

/** One screenshot is one or two files: NN-what-it-shows[.dark].png (dark = dark theme). */
function groups(files: string[]): Group[] {
  const found = new Map<string, Group>();
  for (const file of files) {
    const [, stem, dark] = /^(.*?)(\.dark)?\.png$/.exec(basename(file)) ?? [];
    if (!stem) continue;
    found.set(stem, { ...(found.get(stem) ?? { stem, caption: inline(stem.replace(/^\d+-/, '').replace(/-/g, ' ')) }), [dark ? 'Dark' : 'Light']: file });
  }
  return [...found.values()];
}

/** Screenshots a reader opens only if they want to: both themes side by side, each with its caption. */
function folded(list: Group[], url: (media: string) => string, summary = `${list.length} screenshot${list.length > 1 ? 's' : ''}`): string[] {
  if (!list.length) return [];
  return ['', `<details><summary>${summary}</summary>`, ...screenshots(list.flatMap(g => [g.Light, g.Dark].filter((f): f is string => !!f)), url), '', '</details>'];
}

/**
 * The screenshots of a claim: one is shown, the others are folded. The one shown is the first the model said
 * shows the claim when it looked at it (`seen`); without such an answer, the one taken at the verdict (the last).
 */
function pictures(c: Result['checks'][number], url: (media: string) => string): string[] {
  const all = groups(c.screenshots);
  if (!all.length) return [];
  const yes = c.seen?.find(s => s.shows);
  const main = all.find(g => g.Light === yes?.file) ?? all.at(-1)!;
  const first = main.Light ?? main.Dark!;
  // Only a "yes" is used. ponytail: its "no" was wrong for two true claims out of three tried (an icon it called
  // generic, a layout it measured by eye), so a "no" neither warns nor is quoted; it stays in result.json.
  const says = yes?.file === first ? yes.says : undefined;
  const out = ['', `![${main.caption}](${url(first)})`, `<sub>${main.caption}${says ? ` · the model, looking at this picture: “${inline(says, 300)}”` : ''}</sub>`];
  const rest = all.filter(g => g !== main);
  const twin: Group[] = main.Light && main.Dark ? [{ ...main, Light: undefined }] : [];
  const more = [...twin, ...rest];
  const summary = [twin.length ? 'Dark theme' : '', rest.length ? `${rest.length} more screenshot${rest.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  return [...out, ...folded(more, url, summary)];
}

/** Screenshots with their caption; the two themes of one screenshot side by side. */
export function screenshots(files: string[], url: (media: string) => string): string[] {
  const out: string[] = [];
  for (const group of groups(files)) {
    const { caption } = group;
    const columns = (['Light', 'Dark'] as const).filter(column => group[column]);
    const image = (column: 'Light' | 'Dark'): string => `![${caption}](${url(group[column]!)})`;
    if (columns.length === 1) out.push('', image(columns[0]), `<sub>${caption}${columns[0] === 'Dark' ? ' (dark theme)' : ''}</sub>`);
    else out.push('', `<sub>${caption}</sub>`, '', `| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`, `| ${columns.map(image).join(' | ')} |`);
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
