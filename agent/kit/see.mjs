// After the model has finished driving the app: it is shown the screenshots of each verdict and asked
// whether the picture shows what it wrote. Its answers go into checks.json (`seen`), and the comment shows
// the first picture answered "yes". Not during the run: a second request to Ollama throws away the
// conversation it keeps in memory.
//   node see.mjs <result folder>     model: RVP_RUN_MODEL or RVP_MODEL, Ollama on 127.0.0.1:11434
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const out = process.argv[2];
const model = process.env.RVP_RUN_MODEL || process.env.RVP_MODEL;
const MAX = 8; // pictures per run: about a minute each on a CPU
const PER_CLAIM = 3;

const words = text => new Set(String(text).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const say = line => (console.log(line), appendFileSync(join(out, 'progress.log'), `${new Date().toISOString().slice(11, 19)} ${line}\n`));
const span = seconds => (seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`);

async function ask(file, check) {
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 120 },
      messages: [
        {
          role: 'user',
          images: [readFileSync(join(out, file)).toString('base64')],
          content:
            `This is a screenshot of the Podman Desktop app. A tester checked this claim: "${check.claim}". ` +
            `The tester says it is ${check.status === 'passed' ? 'true' : 'false'} and wrote: "${check.reason ?? ''}". ` +
            'Does this screenshot show what the tester wrote? Answer yes or no, then one short sentence saying what you see.',
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  const says = (await response.json()).message.content.trim().replace(/\s+/g, ' ');
  return { file, shows: /^\W*yes\b/i.test(says), says: says.slice(0, 300) };
}

const checks = JSON.parse(readFileSync(join(out, 'checks.json'), 'utf8'));
const started = Date.now();
let looked = 0;
try {
  for (const [i, check] of checks.entries()) {
    if (check.status === 'skipped') continue;
    const mine = words(check.reason);
    // the pictures most likely to show it first: those whose name shares words with what the tester wrote
    const candidates = (check.screenshots ?? [])
      .filter(file => !file.endsWith('.dark.png'))
      .map((file, at) => ({ file, at, score: [...words(basename(file))].filter(word => mine.has(word)).length }))
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, PER_CLAIM);
    check.seen = [];
    for (const { file } of candidates) {
      if (looked >= MAX) break;
      const at = Date.now();
      const answer = await ask(file, check);
      looked++;
      check.seen.push(answer);
      say(`screenshot check: claim ${i + 1}, ${basename(file)} → ${answer.shows ? 'yes' : 'no'} (${span(Math.round((Date.now() - at) / 1000))})`);
      if (answer.shows) break; // one picture that shows it is enough
    }
  }
} catch (error) {
  // no vision, no model, no time: the comment falls back to the screenshot taken at the verdict
  say(`screenshot check stopped: ${String(error.message ?? error).slice(0, 200)}`);
}
if (looked) {
  const total = `screenshot checks: ${looked} picture${looked > 1 ? 's' : ''} in ${span(Math.round((Date.now() - started) / 1000))}`;
  say(total);
  writeFileSync(join(out, 'looked.txt'), `${total}\n`);
  writeFileSync(join(out, 'checks.json'), JSON.stringify(checks, null, 2));
}
