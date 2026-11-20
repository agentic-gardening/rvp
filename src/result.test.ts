import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inline, render } from './comment';
import { check, finish } from './result';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]);

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rvp-test-'));
  mkdirSync(join(dir, 'media'));
  return dir;
}

test('finish turns recorded checks into a result the comment job accepts', () => {
  const dir = folder();
  writeFileSync(join(dir, 'media', 'a.png'), PNG);
  writeFileSync(
    join(dir, 'checks.json'),
    JSON.stringify([
      { claim: 'scrollbar is absent', status: 'passed', reason: 'no overflow', screenshots: ['media/a.png', '../../etc/passwd'] },
      { claim: 'three extensions install', status: 'failed', reason: '\x1b[31mboom\x1b[0m', screenshots: [] },
      { claim: 'made up status', status: 'great' },
    ]),
  );
  const result = finish(dir, { RVP_PR: '12', RVP_REPO: 'o/r', RVP_RUNNER: 'linux', RVP_MODEL: 'm', RVP_INSTRUCTION: 'i' });
  expect(result.outcome).toBe('mixed');
  expect(result.facts).toEqual([]);
  expect(result.checks).toEqual([
    { claim: 'scrollbar is absent', status: 'passed', reason: 'no overflow', screenshots: ['media/a.png'] },
    { claim: 'three extensions install', status: 'failed', reason: 'boom', screenshots: [] },
  ]);
  expect(check(dir)).toEqual(result);
});

test('one screenshot is shown for a claim: the one the model said shows it; the others are folded', () => {
  const body = render(
    {
      pr: 1, repo: 'o/r', runner: 'Linux arm64', model: 'm', instruction: 'i', outcome: 'pass', notes: '', facts: ['screenshot checks: 2 pictures in 1 min 40 s'],
      checks: [
        {
          claim: 'the tooltip shows', status: 'passed', reason: 'styled tooltip',
          screenshots: ['media/01-hover-run.png', 'media/02-claim-1-passed.png', 'media/02-claim-1-passed.dark.png'],
          seen: [{ file: 'media/02-claim-1-passed.png', shows: false, says: 'No tooltip.' }, { file: 'media/01-hover-run.png', shows: true, says: 'Yes, a tooltip.' }],
        },
        { claim: 'never looked at', status: 'skipped', reason: 'no time', screenshots: [] },
      ],
    },
    m => m,
    'https://github.com/o/r/actions/runs/42',
    '',
  );
  expect(body).toContain('## rvp: ⚠️ Partially verified');
  expect(body).toContain('**1. the tooltip shows** ✅');
  expect(body).toContain('![hover run](media/01-hover-run.png)\n<sub>hover run · the model, looking at this picture: “Yes, a tooltip.”</sub>');
  expect(body).toContain('<details><summary>1 more screenshot</summary>');
  expect(body.indexOf('02-claim-1-passed.png')).toBeGreaterThan(body.indexOf('<details><summary>1 more screenshot'));
  expect(body).toContain('**Not checked:**\n\n- never looked at: no time');
  expect(body).toContain('### Verdict\n⚠️ **Partially verified**: 1 of 2 claims hold, 1 could not be checked.\n- ✅ the tooltip shows\n- ⚠️ never looked at');
  expect(body).toContain('[run 42 and result folder]');
  expect(body).toContain('screenshot checks: 2 pictures in 1 min 40 s');
});

test('no recorded check means no_result, not a crash', () => {
  const dir = folder();
  writeFileSync(join(dir, 'agent.log'), 'model gave up');
  const result = finish(dir, {});
  expect(result.outcome).toBe('no_result');
  expect(result.notes).toContain('model gave up');
  expect(check(dir).outcome).toBe('no_result');
});

test('check refuses media that escapes the folder, is a symlink, or is not an image', () => {
  const write = (dir: string, shot: string) =>
    writeFileSync(
      join(dir, 'result.json'),
      JSON.stringify({ pr: 1, repo: 'o/r', runner: '', model: '', instruction: '', outcome: 'pass', notes: '', checks: [{ claim: 'c', status: 'passed', screenshots: [shot] }] }),
    );
  const dir = folder();
  write(dir, 'media/../../secret.png');
  expect(() => check(dir)).toThrow('bad media path');
  symlinkSync('/etc/hosts', join(dir, 'media', 'link.png'));
  write(dir, 'media/link.png');
  expect(() => check(dir)).toThrow('bad media file');
  writeFileSync(join(dir, 'media', 'fake.png'), 'not a png');
  write(dir, 'media/fake.png');
  expect(() => check(dir)).toThrow('not a png');
});

test('untrusted text cannot mention, link or break out of a code block', () => {
  expect(inline('@maintainer [x](http://evil) <img>')).toBe('@​maintainer \\[x\\](http://evil) &lt;img\\>');
  const body = render(
    { pr: 1, repo: 'o/r', runner: 'linux', model: 'm', instruction: 'i', outcome: 'fail', notes: 'x\n~~~~\n@all', checks: [{ claim: 'c', status: 'failed', reason: '@all', screenshots: [] }] },
    m => m,
    '',
    'click button "x"\n<img src=x> @all',
    'open the page\n~~~~\n@all',
  );
  expect(body).toContain('@​all');
  expect(body).toContain('~~ ~~\n@all\n~~~~'); // notes stay inside their block
  expect(body).toContain('What the agent planned</summary>\n\n~~~~\nopen the page\n~~ ~~\n@all\n~~~~'); // the plan too
  expect(body).toContain('1. click button "x"\n2. &lt;img src=x\\> @​all'); // actions are a list of plain lines
});

test('a skipped claim is not counted as passed in the headline', () => {
  const base = { pr: 1, repo: 'o/r', runner: 'linux', model: 'm', instruction: 'i', outcome: 'pass' as const, notes: '' };
  const passed = { claim: 'a', status: 'passed' as const, screenshots: [] };
  expect(render({ ...base, checks: [passed] }, m => m, '', '')).toContain('## rvp: ✅ Verified');
  expect(render({ ...base, checks: [passed, { claim: 'b', status: 'skipped', screenshots: [] }] }, m => m, '', '')).toContain('## rvp: ⚠️ Partially verified');
  expect(render({ ...base, checks: [passed, { claim: 'b', status: 'failed', screenshots: [] }] }, m => m, '', '')).toContain('## rvp: ❌ Not verified');
  expect(render({ ...base, checks: [{ claim: 'b', status: 'skipped', screenshots: [] }] }, m => m, '', '')).toContain('## rvp: ⚠️ Not checked');
});

test('screenshots of one shot are grouped in a table', async () => {
  const { screenshots } = await import('./comment');
  const url = (f: string): string => f;
  expect(screenshots(['media/01-a-tab.png'], url).join('\n')).toBe('\n![a tab](media/01-a-tab.png)\n<sub>a tab</sub>');
  const themes = screenshots(['media/01-a-tab.png', 'media/01-a-tab.dark.png'], url).join('\n');
  expect(themes).toContain('| Light | Dark |\n|---|---|\n| ![a tab](media/01-a-tab.png) | ![a tab](media/01-a-tab.dark.png) |');
});

test('element ids are removed from the notes', async () => {
  const { withoutIds } = await import('./result');
  expect(
    withoutIds(
      "In region search [id=e554] on Local extensions tab, there is exactly one textbox 'search extensions' [id=e560], positioned in the content region (e553) which comes after the header with tabs (e540-e551)",
    ),
  ).toBe("In region search on Local extensions tab, there is exactly one textbox 'search extensions', positioned in the content region which comes after the header with tabs");
  expect(withoutIds('uses e5 cores, id=f1e12 and e114 here')).toBe('uses e5 cores, and here');
});
