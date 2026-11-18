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
  expect(result.checks).toEqual([
    { claim: 'scrollbar is absent', status: 'passed', reason: 'no overflow', screenshots: ['media/a.png'] },
    { claim: 'three extensions install', status: 'failed', reason: 'boom', screenshots: [] },
  ]);
  expect(check(dir)).toEqual(result);
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
  expect(render({ ...base, checks: [passed] }, m => m, '', '')).toContain('## rvp: ✅ all checks passed');
  expect(render({ ...base, checks: [passed, { claim: 'b', status: 'skipped', screenshots: [] }] }, m => m, '', '')).toContain('## rvp: ✅ 1 passed · ⚪ 1 not checked');
});

test('screenshots of one shot are grouped in a table', async () => {
  const { screenshots } = await import('./comment');
  const url = (f: string): string => f;
  expect(screenshots(['media/01-a-tab.png'], url).join('\n')).toBe('\n![a tab](media/01-a-tab.png)\n<sub>a tab</sub>');
  const themes = screenshots(['media/01-a-tab.png', 'media/01-a-tab.dark.png'], url).join('\n');
  expect(themes).toContain('| Light | Dark |\n|---|---|\n| ![a tab](media/01-a-tab.png) | ![a tab](media/01-a-tab.dark.png) |');
  const all = screenshots(['media/01-a.png', 'media/01-a.dark.png', 'media/01-a.before.png', 'media/01-a.before.dark.png'], url).join('\n');
  expect(all).toContain('| | Light | Dark |\n|---|---|---|\n| Before | ![a](media/01-a.before.png) | ![a](media/01-a.before.dark.png) |\n| After | ![a](media/01-a.png) | ![a](media/01-a.dark.png) |');
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
