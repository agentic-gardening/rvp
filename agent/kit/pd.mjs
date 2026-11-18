// Drive a running Podman Desktop from the shell. Copied to <podman-desktop checkout>/rvp/pd.mjs
// so it uses the checkout's own Playwright and Electron.
//
//   node rvp/pd.mjs serve [--base <checkout>] [extension-folder...]   start the app and keep it running (one per job)
//       --base: also start the app built without the pull request; it follows the first one and every
//       screenshot is taken on both (NN-name.png and NN-name.before.png)
//   node rvp/pd.mjs <command> [args...]           act on it; see HELP
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 47615;
// element ids of the window tree: e12, or f1e12 after the window was reloaded
const ID = /^(f\d+)?e\d+$/;
const checkout = resolve(import.meta.dirname, '..');
const out = process.env.RVP_OUT ?? join(import.meta.dirname, 'out');

const HELP = `commands:
  look [text]            print what the window contains; with text, only the lines around it
  click <id>             click the element with that id (ids look like e12 and come from look)
  fill <id> <text>       type text into a field
  press <key>            press a key, for example Enter or Escape
  eval <javascript>      run an expression in the page and print its value
  shot [id...] <name>    save a screenshot as evidence; elements with these ids are outlined in red
  pass [id...] <claim> <reason>  record that a claim is verified (takes a screenshot, ids outlined)
  fail [id...] <claim> <reason>  record that the app does not do what is claimed (same)
  skip <claim> <reason>  record that a claim could not be checked
  restart [folder...]    restart the app, loading locally built extensions from these folders`;

const [mode, ...args] = process.argv.slice(2);
if (mode === 'serve') await serve(args);
else await client([mode, ...args]);

async function client(command) {
  if (!command[0] || command[0] === 'help') return console.log(HELP);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', body: JSON.stringify(command) });
  } catch {
    console.error('Podman Desktop session is not running.');
    process.exit(2);
  }
  console.log(await response.text());
  process.exit(response.ok ? 0 : 1);
}

async function serve(extensions) {
  const baseAt = extensions.indexOf('--base');
  const baseCheckout = baseAt < 0 ? undefined : resolve(extensions.splice(baseAt, 2)[1]);
  const { _electron: electron } = await import('@playwright/test');
  const media = join(out, 'media');
  mkdirSync(media, { recursive: true });
  mkdirSync(join(out, 'traces'), { recursive: true });

  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const checks = [];
  let app, page, recorder, folders = [], session = 0, shots = 0, pending = [];
  let refused; // the last verdict that was sent back to the model
  let baseApp, basePage, snapshot = ''; // the app without the pull request, and the last tree of the PR app
  const size = { width: 1280, height: 800 };
  // every screenshot is taken once per theme: NN-name.png (light) and NN-name.dark.png
  const themes = process.env.RVP_THEMES === 'false' ? [['', 'light']] : [['', 'light'], ['.dark', 'dark']];

  /**
   * Video without the time where nothing moves: frames go to Playwright's own ffmpeg, and a still
   * frame is held one second at most. Returns undefined when that ffmpeg cannot be used.
   */
  function record(file) {
    try {
      const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
        ?? join(homedir(), { darwin: 'Library/Caches', win32: 'AppData/Local' }[process.platform] ?? '.cache', 'ms-playwright');
      const revision = readdirSync(cache).filter(d => d.startsWith('ffmpeg-')).sort().at(-1);
      const bin = join(cache, revision, readdirSync(join(cache, revision)).find(f => f.startsWith('ffmpeg')));
      const codec = /libvpx[\w-]*/.exec(spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout)[0]; // vp8 or vp9, depends on the build
      const ffmpeg = spawn(
        bin,
        ['-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '25', '-i', 'pipe:0', '-y', '-an',
          '-c:v', codec, '-b:v', '1M', '-deadline', 'realtime', '-speed', '8', file],
        { stdio: ['pipe', 'ignore', 'ignore'] },
      );
      ffmpeg.on('error', () => {});
      ffmpeg.stdin.on('error', () => {});
      const closed = new Promise(done => ffmpeg.on('close', done));
      let last, clock = 0, written = 0;
      // show `last` for `ms` of video time, at 25 frames a second (a frame shown less than 40 ms may be dropped)
      const hold = ms => {
        clock += ms;
        for (; written < Math.floor(clock / 40); written++) ffmpeg.stdin.write(last.data);
      };
      return {
        frame({ data, timestamp }) {
          if (last) hold(Math.min(1000, timestamp - last.timestamp));
          last = { data, timestamp };
        },
        async end() {
          if (last) hold(1000);
          ffmpeg.stdin.end();
          await closed;
        },
      };
    } catch {
      return undefined;
    }
  }

  /** Start the app built in `dir` with its own home, wait until it has a usable window. */
  async function launch(dir) {
    const home = mkdtempSync(join(tmpdir(), 'rvp-home-'));
    mkdirSync(join(home, 'configuration'));
    writeFileSync(
      join(home, 'configuration', 'settings.json'),
      JSON.stringify({ 'preferences.OpenDevTools': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false }),
    );
    const launched = await electron.launch({
      executablePath: createRequire(join(dir, 'package.json'))('electron'), // the Electron of that checkout
      // own user-data dir: no single-instance clash with another Podman Desktop on the machine
      args: ['.', `--user-data-dir=${join(home, 'user-data')}`, ...folders.flatMap(f => ['--extension-folder', resolve(f)])],
      cwd: dir,
      env: { ...process.env, PODMAN_DESKTOP_HOME_DIR: home, ...(process.platform === 'linux' ? { XDG_SESSION_TYPE: 'x11' } : {}) },
      timeout: 120_000,
    });
    const window = await launched.firstWindow();
    await loaded(window);
    // the app follows the system theme: pin it, so a run looks the same on every machine
    await window.emulateMedia({ colorScheme: 'light' });
    return [launched, window];
  }

  // Playwright can attach during a navigation and the preload is lost (blank window): reload.
  async function loaded(window) {
    for (let i = 0; i < 3; i++) {
      await window.waitForLoadState('domcontentloaded');
      if (await window.evaluate(() => 'events' in window)) break;
      await window.reload();
    }
  }

  // welcome screen: telemetry off, then skip
  async function welcome(window) {
    const skipWelcome = window.getByRole('button', { name: 'Skip', exact: true });
    await skipWelcome.waitFor({ timeout: 90_000 });
    await window.getByRole('checkbox', { name: 'Enable telemetry' }).uncheck({ force: true, timeout: 5000 }).catch(() => {});
    await skipWelcome.click();
    await skipWelcome.waitFor({ state: 'hidden', timeout: 15_000 });
  }

  async function start(extensionFolders) {
    folders = extensionFolders;
    session++;
    [app, page] = await launch(checkout);
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    const video = join(media, `session-${session}.webm`);
    recorder = record(video);
    // ponytail: without Playwright's ffmpeg the video is recorded at real speed, idle time included
    await page.screencast.start(recorder ? { onFrame: frame => recorder.frame(frame), size } : { path: video, size });
    await page.screencast.showActions().catch(() => {}); // shows where each click lands
    await welcome(page);
    if (baseCheckout) {
      [baseApp, basePage] = await launch(baseCheckout);
      await welcome(basePage);
    }
  }

  async function stop() {
    if (!app) return;
    await app.context().tracing.stop({ path: join(out, 'traces', `session-${session}.zip`) }).catch(() => {});
    await page.screencast?.stop().catch(() => {});
    await recorder?.end();
    await app.close().catch(() => {});
    await baseApp?.close().catch(() => {});
    app = baseApp = basePage = undefined;
  }

  // --- the app without the pull request follows the other one ---
  // Both apps use the same container engine: what one creates, the other one lists. So the base app
  // must never repeat an action that changes something; it is only brought to the same view.

  /** Role and name of an element of the PR app, read from its last tree: the only way to find "the same" element in the base app. */
  const describe = id => {
    const [, role, name] = new RegExp(`- (\\w+)(?: "((?:[^"\\\\]|\\\\.)*)")?[^\\n]*\\[ref=${id}\\]`).exec(snapshot) ?? [];
    return role && name ? { role, name: name.replace(/\\(.)/g, '$1') } : undefined;
  };
  /** How a person would call an element: button "Local extensions". */
  const what = id => {
    const found = describe(id);
    return found ? `${found.role} "${found.name}"` : 'an element';
  };
  /**
   * Text written by the model, for people: element ids mean nothing to a reader. An id becomes the
   * role and name of its element, or disappears when the text already names it or it has no name.
   */
  const readable = text =>
    String(text)
      .replace(/\s*([[(]?)(id=)?\b((?:f\d+)?e\d+)(-(?:f\d+)?e\d+)?\b[\])]?/g, (match, open, prefix, id, range, offset, whole) => {
        const found = describe(id);
        if (!found) return open || prefix || range ? '' : match; // a bare word that is not an id of this window is left alone
        if (range) return '';
        const before = whole.slice(0, offset).toLowerCase().replace(/['"\s]+$/, '');
        return before.endsWith(found.name.toLowerCase()) ? '' : ` ${found.role} "${found.name}"`;
      })
      .replace(/ {2,}/g, ' ')
      .trim();
  /** One action in plain words, for the run page and the comment. Undefined for commands that only read. */
  const told = (name, args) => {
    const [targets, rest] = ids([...args]);
    const on = targets.length ? targets.map(what).join(', ') : '';
    if (name === 'click') return `click ${on || 'an element'}`;
    if (name === 'fill') return `type "${rest.join(' ')}" into ${on || 'an element'}`;
    if (name === 'press') return `press ${args[0]}`;
    if (name === 'eval') return `run in the page: ${args.join(' ').slice(0, 120)}`;
    if (name === 'shot') return `screenshot${on ? ` of ${on}` : ''}: ${readable(rest.join(' '))}`;
    if (name === 'restart') return `restart the app${args.length ? ` with ${args.length} local extension(s)` : ''}`;
    if (['pass', 'fail', 'skip'].includes(name)) return `${{ pass: 'passed', fail: 'failed', skip: 'skipped' }[name]}: ${readable(rest[0] ?? '')}`;
    return undefined;
  };

  const twin = async id => {
    const found = describe(id);
    const locator = found && basePage.getByRole(found.role, { name: found.name, exact: true }).first();
    return locator && (await locator.count()) ? locator : undefined;
  };
  // ponytail: a button is taken as changing something when its name starts with one of these verbs.
  // A wrong guess either leaves the base app on another view or repeats an action; an allowlist per page would be exact.
  const CHANGES = /^(start|stop|restart|delete|remove|create|pull|build|push|run|deploy|install|uninstall|prune|save|import|export|load|apply|update|upgrade|rename|kill|pause|unpause|enable|disable|add|connect|disconnect|sign|log|init|set|reset|confirm|yes|ok|done|next|submit|upload|download|clone|copy|edit|play)/i;
  const route = window => window.evaluate(() => JSON.stringify([sessionStorage.getItem('last-route'), sessionStorage.getItem('settings-page')]));

  /** After an action on the PR app: do `replay` on the base app (a harmless action), then bring it to the same page. */
  async function follow(replay) {
    if (!basePage) return;
    await replay?.().catch(() => {});
    const wanted = await route(page);
    if ((await route(basePage)) === wanted) return;
    // the app restores these two entries when it reloads: its own "come back where I was"
    await basePage.evaluate(saved => {
      const [last, settings] = JSON.parse(saved);
      for (const [key, value] of [['last-route', last], ['settings-page', settings]]) value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key);
    }, wanted);
    await basePage.reload();
    await loaded(basePage);
    await basePage.waitForTimeout(1500);
  }

  /** The accessibility tree with an id on every element, minus the lines that carry no information. */
  async function tree() {
    snapshot = await page.ariaSnapshot({ mode: 'ai' });
    return snapshot
      .split('\n')
      .filter(line => !/^\s*- generic \[ref=\w+\]:?$/.test(line) && !/^\s*- \/url:/.test(line) && !/^\s*- img \[ref=\w+\]$/.test(line))
      .map(line => line.replace(' [cursor=pointer]', '').replace(/\[ref=(\w+)\]/, '[id=$1]'))
      .join('\n');
  }

  /**
   * The page the app is on and the tabs of that page. The app shows the open tab with colour only
   * (no aria-selected), so the tree cannot tell which one it is: read it from the app's style names.
   * ponytail: tied to Podman Desktop's class names; if they change, the tabs are just not reported.
   */
  async function where() {
    const [last, settings] = JSON.parse(await route(page).catch(() => '[]'));
    const tabs = await page
      .evaluate(() =>
        [...document.querySelectorAll('button[class*="--pd-button-tab-border"], a[class*="--pd-tab-text"]')]
          .filter(el => el.offsetParent)
          .map(el => ({ name: (el.getAttribute('aria-label') ?? el.textContent).trim(), open: /--pd-button-tab-border-selected|--pd-tab-text-highlight/.test(el.className) })),
      )
      .catch(() => []);
    const line = `You are on page ${settings ?? last ?? '/'}.` + (tabs.length ? ` Tabs here: ${tabs.map(t => (t.open ? `[${t.name}] (open)` : t.name)).join(', ')}.` : '');
    return { tabs, line };
  }

  async function look(text, limit = 7000) {
    return `${(await where()).line}\n${await window(text, limit)}`;
  }

  async function window(text, limit) {
    const lines = (await tree()).split('\n');
    if (text) {
      const keep = new Set();
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(text.toLowerCase())) for (let j = i - 3; j <= i + 6; j++) keep.add(j);
      });
      const found = lines.filter((_, i) => keep.has(i)).join('\n');
      return found ? found.slice(0, limit) : `"${text}" is not in the window.`;
    }
    const all = lines.join('\n');
    return all.length > limit ? `${all.slice(0, limit)}\n... cut. Use: look <text> to see the part you need.` : all;
  }

  /** Leading element ids of a command: `shot e12 e15 the two tabs` -> [['e12', 'e15'], ['the two tabs']] */
  const ids = args => {
    const found = [];
    while (ID.test(args[0] ?? '')) found.push(args.shift());
    return [found, args];
  };

  const outline = locator => locator.evaluate(el => Object.assign(el.style, { outline: '3px solid red', outlineOffset: '-3px' })); // inside the element: a parent with overflow hidden cannot clip it
  async function capture(window, stem, marked) {
    for (const [suffix, colorScheme] of themes) {
      await window.emulateMedia({ colorScheme });
      if (suffix) await window.waitForTimeout(300); // let the app repaint in the other theme
      await window.screenshot({ path: join(out, `${stem}${suffix}.png`) });
      pending.push(`${stem}${suffix}.png`);
    }
    await window.emulateMedia({ colorScheme: 'light' });
    for (const locator of marked) await locator.evaluate(el => Object.assign(el.style, { outline: '', outlineOffset: '' })).catch(() => {});
  }

  /**
   * Screenshots of the window, one per theme, and the same on the app without the pull request,
   * with the given elements outlined in red. Returns the first file and a note about ids that were not found.
   */
  async function shot(name, outlined = []) {
    const stem = `media/${String(++shots).padStart(2, '0')}-${slug(name)}`;
    const marked = [], baseMarked = [], missing = [], notBefore = [];
    for (const id of outlined) {
      const locator = page.locator(`aria-ref=${id}`);
      if (!(await locator.count())) { missing.push(id); continue; }
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await outline(locator);
      marked.push(locator);
      if (!basePage) continue;
      const same = await twin(id);
      if (!same) { notBefore.push(id); continue; }
      await same.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await outline(same);
      baseMarked.push(same);
    }
    await capture(page, stem, marked);
    if (basePage) await capture(basePage, `${stem}.before`, baseMarked);
    return [
      `${stem}.png`,
      (missing.length ? ` (no element ${missing.join(', ')} in the window now: not outlined)` : '') +
        (notBefore.length ? ` (${notBefore.join(', ')} does not exist before the pull request)` : ''),
    ];
  }

  const element = async id => {
    if (!ID.test(id ?? "")) throw new Error(`"${id}" is not an element id. Run look and use an id such as e12.`);
    const locator = page.locator(`aria-ref=${id}`);
    if (!(await locator.count())) throw new Error(`there is no element ${id} in the window now. Ids change after every action: run look again.`);
    return locator;
  };
  const after = async what => {
    await page.waitForTimeout(700);
    return `${what}\nThe window now contains (ids have changed):\n${await look(undefined, 4000)}`;
  };

  const commands = {
    look: text => look(text),
    click: async id => {
      await (await element(id)).click({ timeout: 10_000 });
      const found = describe(id);
      // links and tabs only show another view; a button is repeated unless its name says it changes something
      const harmless = found && (found.role !== 'button' || !CHANGES.test(found.name));
      await follow(harmless ? async () => (await twin(id))?.click({ timeout: 5000 }) : undefined);
      return after(`clicked ${id}.`);
    },
    fill: async (id, ...text) => {
      await (await element(id)).fill(text.join(' '), { timeout: 10_000 });
      await follow(async () => (await twin(id))?.fill(text.join(' '), { timeout: 5000 }));
      return after(`filled ${id}.`);
    },
    press: async key => {
      await page.keyboard.press(key);
      await follow(key === 'Enter' ? undefined : () => basePage.keyboard.press(key)); // Enter can submit a form
      return after(`pressed ${key}.`);
    },
    eval: async (...js) => JSON.stringify(await page.evaluate(js.join(' ')))?.slice(0, 2000) ?? 'undefined',
    shot: async (...args) => {
      const [outlined, name] = ids(args);
      return `saved ${(await shot(readable(name.join(' ')) || 'screenshot', outlined)).join('')}`;
    },
    restart: async (...folders) => (await stop(), await start(folders), `restarted with ${folders.length} extension folder(s).`),
    stop: async () => (await stop(), setTimeout(() => process.exit(0), 100), 'stopped.'),
  };
  for (const [verb, status] of [['pass', 'passed'], ['fail', 'failed'], ['skip', 'skipped']]) {
    commands[verb] = async (...args) => {
      const command = JSON.stringify(args);
      const [outlined, [claim, ...reason]] = ids(args);
      if (!claim || !reason.length) throw new Error(`usage: ${verb} [id...] "<claim>" "<reason>"`);
      // small models copy the usage line as it is
      if (/^<.*>$/.test(claim.trim()) || /^<.*>$/.test(reason.join(' ').trim()))
        throw new Error('not recorded: "<claim>" and "<reason>" are placeholders. Write the claim you checked and what you saw, in your own words.');
      // A verdict about a tab that is not the open one is sent back once; the same command again is accepted.
      const task = `${claim} ${process.env.RVP_INSTRUCTION ?? ''}`.toLowerCase();
      const { tabs } = status === 'skipped' || refused === command ? { tabs: [] } : await where();
      const named = tabs.find(t => !t.open && task.includes(t.name.toLowerCase()));
      const open = tabs.filter(t => t.open);
      if (named && !open.some(t => task.includes(t.name.toLowerCase()))) {
        refused = command;
        await tree();
        const [, id] = new RegExp(`"${named.name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snapshot) ?? [];
        throw new Error(
          `not recorded: the task is about "${named.name}", but the open tab is ${open.map(t => `"${t.name}"`).join(', ') || 'another one'}.\n` +
            `Click the "${named.name}" tab${id ? ` (id ${id})` : ''}, look, then give your verdict.\n` +
            `If the open tab really is the right place, send the same command again.`,
        );
      }
      const note = status === 'skipped' ? '' : (await shot(readable(claim), outlined))[1];
      checks.push({ claim: readable(claim), status, reason: readable(reason.join(' ')), screenshots: pending });
      pending = [];
      writeFileSync(join(out, 'checks.json'), JSON.stringify(checks, null, 2));
      return `recorded: ${status}: ${readable(claim)}${note}`;
    };
  }

  await start(extensions);
  let busy = Promise.resolve(); // one command at a time
  createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      busy = busy.then(async () => {
        let text, ok = true;
        const [name, ...rest] = JSON.parse(body);
        const step = told(name, rest); // before the action: the ids are those of the tree the model read
        try {
          if (!commands[name]) throw new Error(`unknown command "${name}".\n${HELP}`);
          let reopened = '';
          if (page.isClosed() && name !== 'stop' && name !== 'restart') {
            // the window was closed (by a person, or the app crashed): open a fresh one rather than fail every command
            await stop();
            await start(folders);
            reopened = 'The app window had closed, so the app was started again: it is back on the Dashboard.\n';
          }
          text = reopened + (await commands[name](...rest));
        } catch (error) {
          ok = false;
          text = `error: ${String(error.message ?? error).split('\n').slice(0, 6).join('\n')}`;
        }
        appendFileSync(join(out, 'actions.log'), `$ ${[name, ...rest].join(' ')}\n${text.slice(0, 600)}\n\n`);
        // one line per action, for whoever watches the run
        const lines = text.split('\n');
        const shown = [...new Set([lines[0], lines.find(line => line.startsWith('You are on'))])].filter(Boolean).join(' ');
        appendFileSync(join(out, 'progress.log'), `${new Date().toISOString().slice(11, 19)} ${(step ?? [name, ...rest].join(' ')).slice(0, 160)} → ${shown.replace(/^(clicked|filled) \S+ ?/, '').slice(0, 200)}\n`);
        // what the comment shows: actions only, in plain words
        if (step) appendFileSync(join(out, 'steps.log'), `${step.replace(/\s+/g, ' ').slice(0, 300)}${ok ? '' : ' (did not work)'}\n`);
        response.writeHead(ok ? 200 : 400).end(text);
      });
    });
  }).listen(PORT, '127.0.0.1', () => console.log('ready'));
}
