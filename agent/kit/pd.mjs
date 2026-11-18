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
  look                   print what can be used or read in the window
  look <text>            print the row or section that contains a text
  look <id>              print one element and everything inside it
  look all               print the whole window, with every wrapper
  click <name or id>     click something: click "Images", or click e12 (ids come from look)
  hover <name or id>     put the mouse on it and print its tooltip; on a row, the tooltips of its buttons
  fill <name or id> <text>   type text into a field
  press <key>            press a key, for example Enter or Escape
  eval <javascript>      run an expression in the page and print its value
  eval <id> <function>   run a function on one element: eval e12 "el => el.getAttribute('title')"
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
  let sinceVerdict = 0; // commands since the last verdict: a small model can go in circles for an hour
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
    // without an id the element was named: click "Images"
    if (name === 'click') return `click ${on || `"${args.join(' ')}"`}`;
    if (name === 'hover') return `hover ${on || `"${args.join(' ')}"`}`;
    if (name === 'eval' && on) return `run on ${on}: ${rest.join(' ').slice(0, 120)}`;
    if (name === 'fill') return on ? `type "${rest.join(' ')}" into ${on}` : `type "${args.slice(1).join(' ')}" into "${args[0]}"`;
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
      .filter(line => !/^\s*- \/url:/.test(line)) // every wrapper is kept: the nesting is read from the indentation
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
    const { tabs, tips } = await page
      .evaluate(() => ({
        tabs: [...document.querySelectorAll('button[class*="--pd-button-tab-border"], a[class*="--pd-tab-text"]')]
          .filter(el => el.offsetParent)
          .map(el => ({ name: (el.getAttribute('aria-label') ?? el.textContent).trim(), open: /--pd-button-tab-border-selected|--pd-tab-text-highlight/.test(el.className) })),
        // a tooltip exists only while the mouse (or the focus) is on its element
        tips: [...document.querySelectorAll('[role="tooltip"]')].filter(el => el.getClientRects().length && el.textContent.trim()).map(el => el.textContent.trim()),
      }))
      .catch(() => ({ tabs: [], tips: [] }));
    const line =
      // long pieces of an address are ids of an image or a container: their start is enough
      `You are on page ${(settings ?? last ?? '/').replace(/[^/]{25,}/g, piece => `${piece.slice(0, 12)}…`)}.` +
      (tabs.length ? ` Tabs here: ${tabs.map(t => (t.open ? `[${t.name}] (open)` : t.name)).join(', ')}.` : '') +
      (tips.length ? ` Tooltip shown: ${tips.map(t => `"${t}"`).join(', ')}.` : '');
    return { tabs, tips, line };
  }

  // --- what the model reads. It is read slowly (about 10 tokens per second on a CPU runner): every line counts. ---
  const ACT = /^(button|link|tab|textbox|searchbox|checkbox|switch|radio|combobox|menuitem|menuitemcheckbox|option|slider)$/;
  const BLOCK = /^(row|listitem|region|dialog|alertdialog|article|menu|toolbar|group|navigation|tablist|form)$/;
  const HINT = 'Use: look "<text>" or look <id> to see one part.';
  const indent = line => line.search(/\S/);
  const parse = line => {
    const [, role, , name] = /^\s*- (\w+)( "((?:[^"\\]|\\.)*)")?/.exec(line) ?? [];
    const rest = line.replace(/^\s*- \w+( "(?:[^"\\]|\\.)*")?/, '');
    return { role, name: name?.replace(/\\(.)/g, '$1'), id: /\[id=(\w+)\]/.exec(rest)?.[1], text: /:\s(.+)$/.exec(rest)?.[1] };
  };
  const WRAP = /^(region|group|generic|navigation|rowgroup|list|table|main|banner|cell)$/;
  /**
   * Only what a person can use or read: the lines with a name or a text, without pictures, indented by
   * what is kept. Wrappers around one thing are removed. `brief` (the default view, and what is
   * compared after an action) also puts a table row and a navigation on one line and leaves the status bar out.
   */
  const compact = (lines, brief = false) => {
    const root = { depth: -1, kids: [] };
    const open = [root];
    let skip = -1; // inside a button or a link there are only the pieces of its name
    for (const line of lines) {
      if (skip >= 0 && indent(line) > skip) continue;
      skip = -1;
      const p = parse(line);
      while (open.at(-1).depth >= indent(line)) open.pop(); // also for a line that is left out: what follows is not inside the previous one
      if (!p.role || p.role === 'img' || p.role === 'separator' || !(p.name || p.text)) continue;
      if (brief && p.role === 'contentinfo') { skip = indent(line); continue; }
      const node = { ...p, depth: indent(line), line: line.trim(), kids: [] };
      open.at(-1).kids.push(node);
      open.push(node);
      if (ACT.test(p.role) && p.role !== 'textbox' && p.role !== 'combobox') skip = indent(line);
    }
    const tidy = node => {
      node.kids = node.kids.flatMap(kid => {
        tidy(kid);
        const wrapper = WRAP.test(kid.role) && !kid.text;
        if (wrapper && !kid.kids.length) return kid.role === 'cell' ? [kid] : []; // a cell with only a name is a value
        return wrapper && kid.kids.length === 1 ? kid.kids : [kid];
      });
    };
    tidy(root);
    const leaves = node => (node.kids.length ? node.kids.flatMap(leaves) : [node]);
    const said = node => `${node.text ?? node.name}${/\[disabled\]/.test(node.line) ? ' (disabled)' : ''}`;
    const kept = [];
    const print = (nodes, level) => {
      const pad = '  '.repeat(level);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const below = node.kids.flatMap(leaves);
        if (brief && node.role === 'navigation' && below.length && below.every(leaf => leaf.role === 'link')) {
          kept.push(`${pad}- navigation: ${below.map(said).join(', ')}`);
        } else if (brief && node.role === 'row' && below.length) {
          const buttons = below.filter(leaf => ACT.test(leaf.role)).map(said);
          const texts = [...new Set(below.filter(leaf => !ACT.test(leaf.role)).map(said))];
          kept.push(`${pad}${node.line.replace(/:$/, '')}: ${texts.join(', ')}${buttons.length ? `. Buttons: ${buttons.join(', ')}` : ''}`);
        } else if (brief && node.role === 'columnheader') {
          let j = i;
          while (nodes[j + 1]?.role === 'columnheader') j++;
          kept.push(`${pad}- columns: ${nodes.slice(i, j + 1).map(said).join(', ')}`);
          i = j;
        } else {
          kept.push(pad + (node.kids.length ? node.line : node.line.replace(/:$/, '')));
          print(node.kids, level + 1);
        }
      }
    };
    print(root.kids, 0);
    return kept;
  };
  /** A line and everything inside it. */
  const within = (lines, i) => {
    let j = i + 1;
    while (j < lines.length && indent(lines[j]) > indent(lines[i])) j++;
    return lines.slice(i, j);
  };
  const cut = (lines, limit, hint) => {
    const shown = [];
    let size = 0;
    for (const line of lines) {
      if (size + line.length > limit) return [...shown, `... ${lines.length - shown.length} more lines. ${hint}`].join('\n');
      shown.push(line);
      size += line.length + 1;
    }
    return shown.join('\n');
  };
  /** The row, list item or section a line is in: -1 when there is none of a readable size. */
  const blockOf = (lines, i) => {
    let level = indent(lines[i]);
    for (let j = i; j >= 0; j--) {
      if (j !== i && indent(lines[j]) >= level) continue;
      level = indent(lines[j]);
      if (BLOCK.test(parse(lines[j]).role ?? '')) return within(lines, j).length > 60 ? -1 : j;
    }
    return -1;
  };
  const menus = lines => {
    const found = lines.map(parse).filter(p => p.id && p.role === 'button' && /menu|more|kebab/i.test(p.name ?? '')).slice(0, 5);
    return found.length ? ` It may be in a menu: ${found.map(p => `"${p.name}" (${p.id})`).join(', ')}.` : '';
  };

  async function look(what, limit = 2000, tries = 3) {
    const lines = (await tree()).split('\n');
    const first = (await where()).line;
    if (!what) return `${first}\n${cut(compact(lines, true), limit, HINT)}`;
    if (what === 'all') return `${first}\n${cut(lines.filter(line => !/^\s*- (generic|img) \[id=\w+\]:?$/.test(line)), 7000, HINT)}`;
    if (ID.test(what)) {
      const i = lines.findIndex(line => line.includes(`[id=${what}]`));
      if (i < 0) throw new Error(`there is no element ${what} in the window now. Run look again.`);
      return `${first}\n${cut(compact(within(lines, i)), 3000, HINT)}`;
    }
    const parts = new Map(); // first line of a part -> its lines
    lines.forEach((line, i) => {
      if (!line.toLowerCase().includes(what.toLowerCase())) return;
      const block = blockOf(lines, i);
      if (block >= 0) parts.set(block, within(lines, block));
      else if (![...parts.keys()].some(start => start <= i && i < start + parts.get(start).length)) parts.set(Math.max(0, i - 3), lines.slice(Math.max(0, i - 3), i + 7));
    });
    if (!parts.size && tries > 1) return (await page.waitForTimeout(1000), look(what, limit, tries - 1)); // it may still be loading
    if (!parts.size) return `${first}\n"${what}" is not in the window.${menus(lines)}`;
    return `${first}\n${cut([...parts.values()].flatMap(part => compact(part)), 3000, HINT)}`;
  }

  /** What appeared and what went away between two views of the window. Ids are left out: the same line keeps the same words. */
  const key = line => line.trim().replace(/ \[(id=\w+|active)\]/g, ''); // [active] is only where the keyboard focus is
  const changes = (before, now) => {
    const left = new Map();
    for (const line of before) left.set(key(line), (left.get(key(line)) ?? 0) + 1);
    const appeared = []; // positions in `now`
    now.forEach((line, i) => {
      if (left.get(key(line))) left.set(key(line), left.get(key(line)) - 1);
      else appeared.push(i);
    });
    return { appeared, gone: [...left].flatMap(([line, times]) => Array(times).fill(line)) };
  };
  const state = async () => compact((await tree()).split('\n'), true);

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
      const locator = await element(id).catch(() => undefined);
      if (!locator) { missing.push(id); continue; }
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
    if (!ID.test(id ?? '')) throw new Error(`"${id}" is not an element id. Run look and use an id such as e12.`);
    // Lists redraw their rows all the time and a redrawn element loses its id. So the element is found
    // again by what the tree said about it (role, name, which one of them), and by its id only as a fallback.
    const lines = snapshot.split('\n');
    const i = lines.findIndex(line => line.includes(`[ref=${id}]`));
    const { role, name } = i < 0 ? {} : parse(lines[i]);
    if (name && role !== 'generic') {
      const earlier = lines.slice(0, i).filter(line => parse(line).role === role && parse(line).name === name).length;
      const again = page.getByRole(role, { name, exact: true }).nth(earlier);
      if (await again.count().catch(() => 0)) return again;
    }
    const locator = page.locator(`aria-ref=${id}`);
    if (!(await locator.count())) throw new Error(`there is no element ${id} in the window now. Run look again.`);
    return locator;
  };
  /** The element a command names: an id from look, or the visible name of something in the window. */
  async function target(words) {
    const given = words.join(' ').trim().replace(/^"(.*)"$/, '$1');
    if (ID.test(given)) return { id: given, locator: await element(given) };
    if (!given) throw new Error('say what: a name such as "Images", or an id such as e12.');
    let lines, all;
    const read = async () => {
      lines = (await tree()).split('\n');
      all = lines.map((line, i) => ({ ...parse(line), i })).filter(p => p.id && p.name);
    };
    const named = (name, role) => {
      const wanted = name.toLowerCase().replace(/^"(.*)"$/, '$1');
      const exact = all.filter(p => p.name.toLowerCase() === wanted && (!role || p.role === role));
      return exact.length ? exact : all.filter(p => p.name.toLowerCase().includes(wanted) && (!role || p.role === role));
    };
    const [, role, rest] = /^(\w+) (.+)$/.exec(given) ?? []; // click link "Extensions"
    let found = [];
    // a list that is still loading: look again for a few seconds before saying it is not there
    for (let tries = 0; tries < 4 && !found.length; tries++) {
      if (tries) await page.waitForTimeout(1000);
      await read();
      found = named(given);
      if (!found.length && rest) found = named(rest, role);
    }
    if (found.some(p => ACT.test(p.role))) found = found.filter(p => ACT.test(p.role));
    if (!found.length) throw new Error(`nothing is named "${given}" in the window.${menus(lines)} Run look to see what is there.`);
    if (found.length > 1) {
      const place = i => {
        const block = blockOf(lines, i);
        const { role, name } = block >= 0 && block !== i ? parse(lines[block]) : {};
        return name ? ` in ${role} "${name.slice(0, 60)}"` : '';
      };
      throw new Error(`${found.length} elements are named "${given}". Use the id of the one you mean:\n${found.slice(0, 8).map(p => `  ${p.id}  ${p.role} "${p.name}"${place(p.i)}`).join('\n')}`);
    }
    return { id: found[0].id, locator: await element(found[0].id) };
  }
  /** The answer to an action: where the app is now, and only what changed in the window. */
  const after = async (done, before) => {
    // a page fills in over a few seconds (lists load): wait until two views in a row say the same
    let now = await state();
    for (let tries = 0; tries < 8; tries++) {
      await page.waitForTimeout(500);
      const next = await state();
      const same = next.length === now.length && next.every((line, i) => key(line) === key(now[i]));
      now = next;
      if (same) break;
    }
    const first = (await where()).line;
    const { appeared, gone } = changes(before, now);
    if (!appeared.length && !gone.length) return `${done}\n${first}\nNothing changed in the window.`;
    // the new lines, each under what it is in (a row, a dialog, a page), so that they can be placed
    const shown = new Set(appeared);
    for (const i of appeared) for (let j = i - 1, level = indent(now[i]); j >= 0 && level > 0; j--) if (indent(now[j]) < level) (shown.add(j), (level = indent(now[j])));
    return (
      `${done}\n${first}` +
      (appeared.length ? `\nAppeared:\n${cut([...shown].sort((a, b) => a - b).map(i => now[i]), 2000, HINT)}` : '') +
      (gone.length ? `\nGone:\n${gone.slice(0, 3).map(line => `  ${line}`).join('\n')}${gone.length > 3 ? `\n  ... and ${gone.length - 3} more lines` : ''}` : '')
    );
  };
  const hoverOne = async locator => {
    await locator.hover({ timeout: 10_000 });
    await page.waitForTimeout(900); // tooltips appear after a delay
    return locator.evaluate(el => {
      const box = el.getBoundingClientRect();
      const tip = [...document.querySelectorAll('[role="tooltip"]')].find(t => t.getClientRects().length && t.textContent.trim());
      const at = tip?.getBoundingClientRect();
      return {
        title: el.getAttribute('title'),
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        menu: el.hasAttribute('aria-haspopup'),
        tip: tip?.textContent.trim(),
        // where the tooltip is, from the two rectangles
        side: !at ? '' : at.bottom <= box.top + 2 ? 'above' : at.top >= box.bottom - 2 ? 'below' : at.right <= box.left + 2 ? 'on the left of' : 'on the right of',
      };
    });
  };
  /** One sentence about the tooltip of a hovered element. A `title` is the browser's own tooltip: it is never in the window tree. */
  const tooltipOf = (seen, role) =>
    seen.tip
      ? `styled tooltip, shown ${seen.side} the ${role}: "${seen.tip}"`
      : seen.title
        ? `no styled tooltip. The browser shows its own tooltip from the title: "${seen.title}"`
        : 'no tooltip: no styled one, and no title';
  /** Records what the tooltip says while an action runs: a text that lasts a moment is over before the next command. */
  const watchTooltip = () =>
    page.evaluate(() => {
      const seen = [];
      const read = () => [...document.querySelectorAll('[role="tooltip"]')].filter(t => t.getClientRects().length && t.textContent.trim()).map(t => `"${t.textContent.trim()}"`).join(', ') || 'gone';
      const timer = setInterval(() => seen.at(-1) !== read() && seen.push(read()), 50);
      globalThis.__rvpTooltip = () => (clearInterval(timer), seen);
    });
  const watchedTooltip = async () => {
    const seen = await page.evaluate(() => globalThis.__rvpTooltip?.() ?? []).catch(() => []);
    return seen.length > 1 ? `Tooltip during the click: ${seen.join(' → ')}` : '';
  };

  const commands = {
    // `look cell e59`: the id is what was meant
    look: (...words) => look(words.find(word => ID.test(word)) ?? (words.join(' ') || undefined)),
    click: async (...words) => {
      const { id, locator } = await target(words);
      const [label, found, before] = [what(id), describe(id), await state()];
      await watchTooltip();
      await locator.click({ timeout: 10_000 });
      // links and tabs only show another view; a button is repeated unless its name says it changes something
      const harmless = found && (found.role !== 'button' || !CHANGES.test(found.name));
      await follow(harmless ? async () => (await twin(id))?.click({ timeout: 5000 }) : undefined);
      const answer = await after(`clicked ${label}.`, before);
      return [answer, await watchedTooltip()].filter(Boolean).join('\n');
    },
    hover: async (...words) => {
      const { id, locator } = await target(words);
      const label = what(id);
      const lines = (await tree()).split('\n');
      const i = lines.findIndex(line => line.includes(`[id=${id}]`));
      // on a row, a cell or a toolbar: every button in it, one line each
      const inside = i < 0 || ACT.test(parse(lines[i]).role ?? '') ? [] : within(lines, i).slice(1).map(parse).filter(p => p.id && /^(button|link)$/.test(p.role)).slice(0, 12);
      if (inside.length) {
        const rows = [];
        for (const p of inside) {
          const seen = await element(p.id).then(hoverOne).catch(() => undefined);
          rows.push(`  ${p.role} "${p.name ?? ''}" [id=${p.id}]${seen?.disabled ? ' (disabled)' : ''}${seen?.menu ? ' (opens a menu)' : ''}: ${seen ? tooltipOf(seen, p.role) : 'could not be hovered'}`);
        }
        return `hovering ${label}: ${inside.length} buttons inside\n${rows.join('\n')}`;
      }
      const seen = await hoverOne(locator);
      await follow(async () => (await twin(id))?.hover({ timeout: 5000 }));
      return `hovering ${label}${seen.disabled ? ' (disabled)' : ''}\n  ${tooltipOf(seen, describe(id)?.role ?? 'element')}`;
    },
    fill: async (first, ...text) => {
      const { id, locator } = await target([first]);
      const [label, before] = [what(id), await state()];
      await locator.fill(text.join(' '), { timeout: 10_000 });
      await follow(async () => (await twin(id))?.fill(text.join(' '), { timeout: 5000 }));
      return after(`filled ${label}.`, before);
    },
    press: async key => {
      const before = await state();
      await page.keyboard.press(key);
      await follow(key === 'Enter' ? undefined : () => basePage.keyboard.press(key)); // Enter can submit a form
      return after(`pressed ${key}.`, before);
    },
    eval: async (...args) => {
      let [targets, js] = ids([...args]);
      const code = js.join(' ');
      const print = value => JSON.stringify(value)?.slice(0, 2000) ?? 'undefined';
      const known = id => snapshot.includes(`[ref=${id}]`);
      const refuse = id => new Error(`${id} is not an id in the page: ids exist only for these commands. Use: look ${id} (what is inside it), hover ${id} (its tooltip), or eval ${id} "el => el.getAttribute('title')"`);
      // `e561 => ...`: a function on that element, as small models write it
      const [arrow, param] = /^\s*((?:f\d+)?e\d+)\s*=>/.exec(code) ?? [];
      if (!targets.length && param && known(param)) {
        if (new RegExp(`['"#=\\[]\\s*${param}\\b`).test(code.slice(arrow.length))) throw refuse(param);
        targets = [param];
      }
      if (targets.length) {
        // the element is handed over through the page: the function then runs like any other expression
        await (await element(targets[0])).evaluate(el => void (globalThis.__rvpElement = el));
        return print(await page.evaluate(`(${code})(globalThis.__rvpElement)`));
      }
      const used = (code.match(/\b(?:f\d+)?e\d+\b/g) ?? []).find(known);
      if (used) throw refuse(used);
      return print(await page.evaluate(code));
    },
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
      if (!claim) throw new Error(`usage: ${verb} [id...] "<claim>" "<reason>"`);
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
      sinceVerdict = -1; // this command is counted right after
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
          // going in circles: nothing but a verdict is accepted any more, and a skip is a fine verdict
          if (sinceVerdict >= 25 && !['pass', 'fail', 'skip', 'stop', 'restart'].includes(name))
            throw new Error(`${sinceVerdict} commands without a verdict: not run. Record pass, fail or skip for the claim you are on (skip "<claim>" "<what you tried>" if you could not see it). After that you can go on.`);
          if (!commands[name]) throw new Error(`unknown command "${name}". The commands are: ${Object.keys(commands).filter(c => c !== 'stop').join(', ')}. Example: node rvp/pd.mjs click "Images"`);
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
        if (++sinceVerdict >= 12 && name !== 'stop') text += `\n${sinceVerdict} commands since the last verdict. Record pass, fail or skip for the claim you are on, then go to the next one.`;
        appendFileSync(join(out, 'actions.log'), `$ ${[name, ...rest].join(' ')}\n${text.slice(0, 600)}\n\n`);
        // one line per action, for whoever watches the run
        const lines = text.split('\n');
        const here = lines.find(line => line.startsWith('You are on'));
        const shown = here && /^(clicked|filled|pressed) /.test(lines[0]) ? here : [...new Set([lines[0], here])].filter(Boolean).join(' ');
        appendFileSync(join(out, 'progress.log'), `${new Date().toISOString().slice(11, 19)} ${(step ?? [name, ...rest].join(' ')).slice(0, 160)} → ${shown.slice(0, 200)}\n`);
        // what the comment shows: actions only, in plain words
        if (step) appendFileSync(join(out, 'steps.log'), `${step.replace(/\s+/g, ' ').slice(0, 300)}${ok ? '' : ' (did not work)'}\n`);
        response.writeHead(ok ? 200 : 400).end(text);
      });
    });
  }).listen(PORT, '127.0.0.1', () => console.log('ready'));
}
