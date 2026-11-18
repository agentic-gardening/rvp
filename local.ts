// Run the steps of agent/action.yml on this machine (macOS or Linux), the way a runner would.
//   bun run local <pr> "<instruction>" [model] [--before-after | --no-before-after] [--no-themes] [--gist]
// Needs gh (logged in), Node 24 and pnpm. Everything goes to .local/ ; rm -rf .local to start over.
// The comment is written to .local/rvp-out/comment.md and never posted on the pull request.
// --gist also publishes it, with its screenshots, as a secret gist on your own account.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dir;
const work = join(root, '.local');
const action: any = Bun.YAML.parse(readFileSync(join(root, 'agent/action.yml'), 'utf8'));

const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const [pr, instruction, model] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!pr || !instruction) {
  console.error('usage: bun run local <pr> "<instruction>" [model] [--before-after | --no-before-after] [--no-themes] [--gist]');
  process.exit(2);
}
const inputs: Record<string, string> = Object.fromEntries(Object.entries<any>(action.inputs).map(([name, input]) => [name, String(input.default ?? '')]));
// the token input stays empty: gh then uses your own login
Object.assign(inputs, { pr, instruction, token: '', 'before-after': flags.includes('--before-after') ? 'true' : flags.includes('--no-before-after') ? 'false' : 'auto', themes: String(!flags.includes('--no-themes')) });
if (model) inputs.model = model;
const runnerOs = process.platform === 'darwin' ? 'macOS' : 'Linux';
const marker = join(work, 'pd/.rvp-pr');
const built = existsSync(marker) && readFileSync(marker, 'utf8') === pr;
const baseMarker = join(work, 'pd-base/.rvp-pr');
const baseBuilt = existsSync(baseMarker) && readFileSync(baseMarker, 'utf8') === pr;

// what a cache hit, or a machine that is already set up, would skip
const skip: Record<string, boolean> = {
  'download ollama and pi': existsSync(join(work, 'rvp-tools/pi')),
  'fetch the pull request': built,
  'build Podman Desktop': built,
  'fetch the base of the pull request': baseBuilt,
  'build the base': baseBuilt,
  display: !(runnerOs === 'Linux' && !process.env.DISPLAY),
};

const bash = (script: string, cwd: string, env: Record<string, string | undefined>): boolean =>
  Bun.spawnSync(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] }).exitCode === 0;

mkdirSync(work, { recursive: true });
const githubEnv = join(work, 'env');
const base = { ...process.env, GITHUB_STEP_SUMMARY: join(work, 'summary.md'), RUNNER_TEMP: work, RUNNER_OS: runnerOs, GITHUB_ACTION_PATH: join(root, 'agent'), GITHUB_ENV: githubEnv };
if (existsSync(join(work, 'pd/rvp/pd.mjs'))) bash('node rvp/pd.mjs stop > /dev/null 2>&1 || true', join(work, 'pd'), base); // left over from an interrupted run
rmSync(join(work, 'rvp-out'), { recursive: true, force: true });
writeFileSync(githubEnv, '');
rmSync(join(work, 'summary.md'), { force: true });

let failed = '';
for (const step of action.runs.steps) {
  if (!step.run || skip[step.name]) continue;
  if (failed && !String(step.if).includes('always()')) continue;
  const fromEnv = (): Record<string, string> => Object.fromEntries(readFileSync(githubEnv, 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const [, scope, name, value] = /(inputs|env)\.([\w-]+) == '([^']*)'/.exec(String(step.if)) ?? [];
  if (scope && (scope === 'inputs' ? inputs : fromEnv())[name] !== value) continue;
  console.log(`\n=== ${step.name}`);
  const env: Record<string, string | undefined> = { ...base };
  Object.assign(env, fromEnv());
  for (const [name, value] of Object.entries<string>(step.env ?? {})) {
    const resolved = String(value).replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (_, input) => inputs[input] ?? '').replace(/\$\{\{\s*runner\.os\s*\}\}/g, runnerOs);
    if (resolved) env[name] = resolved;
  }
  if (!bash(step.run, join(work, step['working-directory'] ?? ''), env)) failed ||= step.name;
  else if (step.name === 'build Podman Desktop') writeFileSync(marker, pr);
  else if (step.name === 'build the base') writeFileSync(baseMarker, pr);
}

bash(`pkill -f "${work}/rvp-tools/ollama" || true`, work, base);
const out = join(work, 'rvp-out');
const run = (cmd: string[], cwd = root): string => {
  const done = Bun.spawnSync(cmd, { cwd, stderr: 'inherit' });
  if (done.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed`);
  return done.stdout.toString().trim();
};
const comment = (imagePrefix = ''): void => writeFileSync(join(out, 'comment.md'), run(['node', 'comment/dist/index.mjs', '--dry-run', out, imagePrefix].filter(Boolean)) + '\n');
comment();
console.log(`\n=== comment (not posted)\n${readFileSync(join(out, 'comment.md'), 'utf8')}`);
console.log(`result folder: ${out}\ncomment:       ${out}/comment.md`);

if (flags.includes('--gist') && !failed) {
  // gh creates secret gists unless told otherwise. Secret = unlisted: whoever has the link can read it.
  const url = run(['gh', 'gist', 'create', join(out, 'comment.md'), '--desc', `rvp local run: ${inputs.repo}#${pr}`]).split('\n').pop()!;
  const id = url.split('/').pop()!;
  const raw = `https://gist.githubusercontent.com/${run(['gh', 'api', 'user', '--jq', '.login'])}/${id}/raw/`;
  comment(raw);
  // GitHub does not play a video from a link, in a gist or in a comment: it is a file to download
  const videos = readdirSync(join(out, 'media')).filter(f => f.endsWith('.webm'));
  if (videos.length) appendFileSync(join(out, 'comment.md'), `\nVideo (download): ${videos.map(v => `[${v}](${raw}${v})`).join(', ')}\n`);
  // a gist is a git repository: that is the only way to add images to it
  const clone = join(work, 'gist');
  rmSync(clone, { recursive: true, force: true });
  const git = ['git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
  run([...git, 'clone', '-q', `https://gist.github.com/${id}.git`, clone]);
  cpSync(join(out, 'comment.md'), join(clone, 'comment.md'));
  for (const file of readdirSync(join(out, 'media')).filter(f => /\.(png|webm)$/.test(f))) cpSync(join(out, 'media', file), join(clone, file));
  run(['git', 'add', '-A'], clone);
  run(['git', 'commit', '-q', '-s', '-m', 'comment and screenshots'], clone);
  run([...git, 'push', '-q'], clone);
  console.log(`gist (secret): ${url}`);
}
if (failed) {
  console.error(`step failed: ${failed}`);
  process.exit(1);
}
