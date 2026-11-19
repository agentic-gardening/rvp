// Drive a running Podman Desktop from the shell. Copied to <podman-desktop checkout>/rvp/pd.mjs: it
// starts the Electron of that checkout and talks to it through agent-browser (on the PATH, or RVP_AB).
// agent-browser does the browser work; this file decides what the model reads, which is what a run costs.
//
//   node rvp/pd.mjs serve [extension-folder...]   start the app and keep it running (one per job)
//   node rvp/pd.mjs <command> [args...]           act on it; see HELP
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 47615;
// element ids of the window tree, as agent-browser gives them: e12
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
  claims                 print the numbered claims to verify
  pass <number> [id...] <reason>  record that this claim is verified (takes a screenshot, ids outlined)
  fail <number> [id...] <reason>  record that the app does not do what the claim says (same)
  skip <number> <reason>  record that this claim could not be checked
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
  const media = join(out, 'media');
  mkdirSync(media, { recursive: true });

  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
  // The claims are the sentences of the instruction, numbered here: the model answers them by number.
  // When it wrote them itself it recorded one twice, passed what it had seen fail, and never knew it was done.
  // ponytail: one sentence = one claim; "e.g. x" splits in two, write the instruction without it
  const claims = (process.env.RVP_INSTRUCTION ?? '').match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(c => c.trim()).filter(c => c.length > 3) ?? [];
  if (!claims.length) claims.push(process.env.RVP_INSTRUCTION || 'the pull request does what it says');
  const verdicts = new Map(); // claim number -> check
  const open = () => claims.map((_, i) => i + 1).filter(n => !verdicts.has(n));
  const left = () => (open().length ? `Open: ${open().map(n => `claim ${n}`).join(', ')}.` : 'All claims have a verdict: write rvp/notes.md and stop.');
  let app, home, alive = false, folders = [], shots = 0;
  let moments = []; // screenshots since the last verdict, one entry per moment: they are the evidence of the next one
  let refused; // the last verdict that was sent back to the model
  const lastChange = new Map(); // action -> what it changed in the window the last time
  let lost; // an answer nobody read: the model put a timeout on its command and was gone before the end
  let sinceVerdict = 0; // commands since the last verdict: a small model can go in circles for an hour
  let snapshot = ''; // the last tree of the window
  // every screenshot is taken once per theme: NN-name.png (light) and NN-name.dark.png
  const themes = process.env.RVP_THEMES === 'false' ? [['', 'light']] : [['', 'light'], ['.dark', 'dark']];

  const sleep = ms => new Promise(done => setTimeout(done, ms));
  const CDP = process.env.RVP_CDP_PORT ?? '9339';
  /** One agent-browser command; its output, or an error of one line. */
  const ab = (...args) =>
    new Promise((done, fail) =>
      execFile(
        process.env.RVP_AB || 'agent-browser',
        args,
        { env: { ...process.env, AGENT_BROWSER_SESSION: 'rvp', AGENT_BROWSER_NO_VERSION_CHECK: '1' }, maxBuffer: 32e6, timeout: 40_000, windowsHide: true },
        (error, stdout, stderr) => {
          const text = String(stdout).trim();
          if (!error && !text.startsWith('✗')) return done(text.replace(/^✓ Done$/, ''));
          fail(new Error((text || String(stderr).trim() || error.message).replace(/^✗\s*/, '').split('\n')[0].slice(0, 200)));
        },
      ),
    );
  /** The value of a JavaScript expression in the window; undefined when it has none. */
  const js = async code => {
    try {
      return JSON.parse(await ab('eval', code));
    } catch {
      return undefined;
    }
  };
  // what each id printed so far was, and on which page: an id used on another page is answered with that
  const known = new Map();
  let page = '/';
  const remember = () => {
    for (const [, what, id] of snapshot.matchAll(/^\s*- (\w+(?: "(?:[^"\\]|\\.)*")?).*\[ref=(\w+)\]/gm)) known.set(id, { what: what.slice(0, 70), page });
  };
  const gone = id => {
    const was = known.get(id);
    return was && was.page !== page
      ? `${id} was ${was.what} on ${was.page}; you are on ${page}. Open that page first.`
      : `there is no element ${id} in the window now. Run look again.`;
  };
  /** An action on one element. An id from an old view that agent-browser cannot find again is said in our words. */
  const act = (verb, id, ...rest) =>
    ab(verb, `@${id}`, ...rest).catch(error => {
      throw new Error(/unknown ref|not found|no element/i.test(error.message) ? gone(id) : error.message);
    });
  const boxOf = async id => {
    const { data } = JSON.parse(await ab('get', 'box', `@${id}`, '--json'));
    if (!data) throw new Error(gone(id));
    return { x: data.x, y: data.y, width: data.width, height: data.height };
  };
  // The element of a box, for JavaScript in the page: the one whose rectangle it is. Not elementFromPoint,
  // which never returns a disabled button. ponytail: two elements of the very same rectangle; the control wins.
  const AT = box => `(b => { const all = [...document.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return Math.abs(r.x - b.x) < 1 && Math.abs(r.y - b.y) < 1 && Math.abs(r.width - b.width) < 1 && Math.abs(r.height - b.height) < 1; }); return all.find(el => el.matches('button,a,input,select,textarea,[role],[title]')) ?? all[0] ?? null; })(${JSON.stringify(box)})`;

  /** Start the app of this checkout with its own home, attach agent-browser, wait until the window is usable. */
  async function launch() {
    home = mkdtempSync(join(tmpdir(), 'rvp-home-'));
    mkdirSync(join(home, 'configuration'));
    writeFileSync(
      join(home, 'configuration', 'settings.json'),
      JSON.stringify({ 'preferences.OpenDevTools': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false }),
    );
    const started = spawn(
      createRequire(join(checkout, 'package.json'))('electron'), // the Electron of the checkout
      // own user-data dir: no single-instance clash with another Podman Desktop on the machine
      ['.', `--user-data-dir=${join(home, 'user-data')}`, `--remote-debugging-port=${CDP}`, ...folders.flatMap(f => ['--extension-folder', resolve(f)])],
      { cwd: checkout, stdio: 'ignore', env: { ...process.env, PODMAN_DESKTOP_HOME_DIR: home, ...(process.platform === 'linux' ? { XDG_SESSION_TYPE: 'x11' } : {}) } },
    );
    started.on('error', () => {});
    started.on('exit', () => started === app && (alive = false));
    app = started;
    alive = true;
    for (let tries = 0; ; tries++) {
      if (await ab('connect', CDP).then(() => true, () => false)) break;
      if (tries > 120 || !alive) throw new Error('Podman Desktop did not start, or agent-browser could not attach to it.');
      await sleep(1000);
    }
    // The window exists before the app is loaded in it. And attaching while it loads can leave it blank
    // (the app's preload did not run): it is then reloaded, as a person would.
    const loaded = () => js(`'events' in window`);
    for (let reloads = 0; reloads < 4 && !(await loaded()); reloads++) {
      for (let tries = 0; tries < 20 && !(await loaded()); tries++) await sleep(1000);
      if (!(await loaded())) await ab('reload').catch(() => {});
    }
    // the app follows the system theme: pin it, so a run looks the same on every machine
    await ab('set', 'media', 'light');
  }

  // welcome screen: telemetry off, then skip
  async function welcome() {
    const find = (lines, role, name) => lines.map(parse).find(p => p.id && p.role === role && name.test(p.name ?? ''));
    let lines = [];
    for (let tries = 0; tries < 90 && !find(lines, 'button', /^Skip$/); tries++) {
      if (tries) await sleep(1000);
      lines = (await tree()).split('\n');
    }
    const telemetry = find(lines, 'checkbox', /telemetry/i);
    if (telemetry) await ab('uncheck', `@${telemetry.id}`).catch(() => {});
    await ab('click', `@${find(lines, 'button', /^Skip$/).id}`);
    for (let tries = 0; tries < 15 && find((await tree()).split('\n'), 'button', /^Skip$/); tries++) await sleep(1000);
  }

  async function start(extensionFolders) {
    folders = extensionFolders;
    await launch();
    await welcome();
  }

  async function stop() {
    if (!app) return;
    await ab('close').catch(() => {});
    app.kill();
    app = undefined;
    alive = false;
  }

  /** Role and name of an element, read from the last tree. */
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
    if (name === 'extension') return `read what the extension "${args.join(' ')}" adds`;
    if (name === 'size') return `screenshots at window sizes ${args.join(' ') || '800x600, 1280x800, 1920x1080'}`;
    if (name === 'eval') return `run in the page: ${args.join(' ').slice(0, 120)}`;
    if (name === 'shot') return `screenshot${on ? ` of ${on}` : ''}: ${readable(rest.join(' '))}`;
    if (name === 'restart') return `restart the app${args.length ? ` with ${args.length} local extension(s)` : ''}`;
    if (['pass', 'fail', 'skip'].includes(name)) return `${{ pass: 'passed', fail: 'failed', skip: 'skipped' }[name]}: ${readable(rest.join(' ').replace(/^\d+\s+/, ''))}`;
    return undefined;
  };

  /**
   * The accessibility tree of the window. agent-browser prints `- button "Pull" [disabled, ref=e7]` and
   * `- StaticText "x"`; it is brought to one form here: `- button "Pull" [disabled] [ref=e7]`, `- text: x`.
   * A checkbox always says its state, [on] or [off]: unchecked is as much a fact as checked.
   */
  async function tree() {
    snapshot = (await ab('snapshot'))
      .split('\n')
      .map(line => {
        const [, pad, role, name, flags = ''] = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?/.exec(line) ?? [];
        if (!role) return line;
        if (role === 'StaticText') return `${pad}- text: ${name ?? ''}`;
        const said = flags.split(', ').flatMap(flag => {
          const [key, value] = flag.split('=');
          if (key === 'ref') return [`[ref=${value}]`];
          if (key === 'checked') return [value === 'true' ? '[on]' : value === 'false' ? '[off]' : '[partly on]'];
          return key === 'disabled' || (value === 'true' && /^(expanded|pressed|selected)$/.test(key)) ? [`[${key}]`] : [];
        });
        // the ref last: the rest of the file reads a line as "what it is", then its id
        return `${pad}- ${role}${name === undefined ? '' : ` "${name}"`}${[...said.filter(f => !f.startsWith('[ref=')), ...said.filter(f => f.startsWith('[ref='))].map(f => ` ${f}`).join('')}`;
      })
      .join('\n');
    remember();
    return snapshot.replace(/\[ref=(\w+)\]/g, '[id=$1]');
  }

  /**
   * The page the app is on and the tabs of that page. The app shows the open tab with colour only
   * (no aria-selected), so the tree cannot tell which one it is: read it from the app's style names.
   * ponytail: tied to Podman Desktop's class names; if they change, the tabs are just not reported.
   */
  async function where() {
    const { last, settings, tabs = [], tips = [] } =
      (await js(`(() => ({
        last: sessionStorage.getItem('last-route'),
        settings: sessionStorage.getItem('settings-page'),
        tabs: [...document.querySelectorAll('button[class*="--pd-button-tab-border"], a[class*="--pd-tab-text"]')]
          .filter(el => el.offsetParent && !el.closest('[role="dialog"],[role="alertdialog"]'))
          .map(el => ({ name: (el.getAttribute('aria-label') ?? el.textContent).trim(), open: /--pd-button-tab-border-selected|--pd-tab-text-highlight/.test(el.className) })),
        tips: [...document.querySelectorAll('[role="tooltip"]')].filter(el => el.getClientRects().length && el.textContent.trim()).map(el => el.textContent.trim()),
      }))()`)) ?? {}; // a tooltip exists only while the mouse (or the focus) is on its element
    page = settings ?? last ?? '/';
    remember();
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
  const HINT = 'Use: look "<text>" to see one part.';
  const indent = line => line.search(/\S/);
  const parse = line => {
    const [, role, , name] = /^\s*- (\w+)( "((?:[^"\\]|\\.)*)")?/.exec(line) ?? [];
    const rest = line.replace(/^\s*- \w+( "(?:[^"\\]|\\.)*")?/, '');
    return { role, name: name?.replace(/\\(.)/g, '$1'), id: /\[id=(\w+)\]/.exec(rest)?.[1], text: /:\s(.+)$/.exec(rest)?.[1] };
  };
  const WRAP = /^(region|group|generic|navigation|rowgroup|list|table|main|banner|cell|LabelText|paragraph)$/;
  const PLAIN = /^(heading|region|generic|paragraph|navigation|table|list|status|columnheader|form|article|text)$/;
  const ROWS = 12; // rows of a list shown in the default view: two in full, the others with their first values
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
      if (!p.role || p.role === 'img' || p.role === 'image' || p.role === 'LineBreak' || p.role === 'separator' || !(p.name || p.text)) continue;
      // the text of a thing that already says it: heading "Images" > text "Images"
      if (p.role === 'text' && open.at(-1).name?.trim().toLowerCase() === p.text.trim().toLowerCase()) continue;
      if (brief && p.role === 'contentinfo') { skip = indent(line); continue; }
      // [level] and [active] (the keyboard focus) say nothing useful here; a long text is cut
      const shown = line.trim().replace(/ \[(level=\d+|active)\]/g, '').replace(/(: .{100}).+$/, '$1…');
      const node = { ...p, depth: indent(line), line: shown, kids: [] };
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
      // A sentence arrives in pieces (text, bold, code): one line. And a text that the control next to it
      // already says is not repeated: the label of a field, the description of a switch, its "Enabled".
      const kids = [];
      node.kids.forEach((kid, i) => {
        const last = kids.at(-1);
        if (kid.role !== 'text') return kids.push(kid);
        const said = kid.text.trim().toLowerCase();
        const control = node.kids.slice(i + 1).find(next => next.role !== 'text');
        if (control && ACT.test(control.role) && (control.name?.toLowerCase().includes(said) || /^(checkbox|switch)$/.test(control.role) && /^(enabled|disabled)$/.test(said))) return;
        if (last?.role === 'text' && last.text.trim().toLowerCase() === said) return;
        // pieces of one sentence touch (a space or a comma at the join, or a very short piece such as a quote);
        // two texts that only follow each other are kept apart
        const glued = /\s$/.test(last?.text ?? '') || /^[\s,.;:)]/.test(kid.text) || kid.text.trim().length < 3 || (last?.text?.trim().length ?? 9) < 3;
        if (last?.role === 'text') last.text = `${last.text}${glued ? '' : ' · '}${kid.text}`.replace(/\s+/g, ' ');
        else kids.push({ ...kid });
      });
      for (const kid of kids) if (kid.role === 'text') kid.line = `- text: ${kid.text.trim().replace(/^(.{100}).+$/, '$1…')}`;
      node.kids = kids;
      // a thing that holds one text says it on its own line: heading "Title": Resources
      if (node.line && !ACT.test(node.role) && node.role !== 'row' && kids.length === 1 && kids[0].role === 'text') {
        node.text = kids[0].text.trim();
        node.line = `${node.line}: ${node.text.replace(/^(.{100}).+$/, '$1…')}`;
        node.kids = [];
      }
    };
    tidy(root);
    // The buttons of the title bar and the tab links: in every view and never the subject of a claim. They still
    // work by name (click "Back"), and the first line of an answer already says the tabs.
    if (brief) root.kids = root.kids.filter(kid => !(kid.role === 'button' && /^((Back|Forward) \(hold for history\)|Search|Minimize|Maximize|Close)$/.test(kid.name ?? '')) && !(kid.role === 'region' && kid.name === 'Tabs'));
    const leaves = node => (node.kids.length ? node.kids.flatMap(leaves) : [node]);
    const said = node => `${node.text ?? node.name}${/\[disabled\]/.test(node.line) ? ' (disabled)' : ''}`;
    const kept = [];
    const print = (nodes, level) => {
      const pad = '  '.repeat(level);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const below = node.kids.flatMap(leaves);
        const links = below.filter(leaf => leaf.role === 'link');
        if (brief && node.role === 'row' && nodes.slice(0, i).filter(n => n.role === 'row').length >= ROWS) {
          // a long list is cut by row, not in the middle of one
          const more = nodes.slice(i).filter(n => n.role === 'row');
          kept.push(`${pad}… ${more.length} more rows. Use: look "<name>" to see one.`);
          i = nodes.lastIndexOf(more.at(-1));
        } else if (brief && node.role === 'navigation' && links.length >= 3 && below.every(leaf => leaf.role === 'link' || leaf.role === 'text')) {
          // any menu of links, on one line; the text in it is its title ("Settings")
          const title = below.find(leaf => leaf.role === 'text')?.text.trim();
          // a long menu (the sections of a settings page) is named by its first entries
          kept.push(`${pad}- navigation${title ? ` "${title}"` : ''}: ${links.slice(0, 12).map(said).join(', ')}${links.length > 12 ? `, … ${links.length - 12} more` : ''}`);
        } else if (brief && node.role === 'row' && below.length) {
          // with their ids: several rows have the same buttons, so a name alone is not enough to use one
          // an open menu is said: its items look like more buttons of the row otherwise
          // ponytail: the items of an open menu are the buttons after the menu button, which is the last action of a row
          const acts = below.filter(leaf => ACT.test(leaf.role));
          const menuAt = acts.findIndex(leaf => leaf.role === 'button' && /menu|kebab|more/i.test(leaf.name ?? ''));
          const menu = new Set(menuAt < 0 ? [] : acts.slice(menuAt + 1));
          const label = leaf => `${leaf.text ?? leaf.name}${/ \[id=\w+\]/.exec(leaf.line)?.[0] ?? ''}${/\[disabled\]/.test(leaf.line) ? ' (disabled)' : ''}`;
          const open = [...menu].filter(leaf => ACT.test(leaf.role)).map(label);
          // The button that carries the name of the row opens its item: its id is given as the id of the row.
          // The selection checkbox is left out: `look "<name>"` shows a row with everything in it.
          const opener = below.find(leaf => leaf.role === 'button' && node.name && leaf.name?.startsWith(node.name));
          const buttons = below.filter(leaf => ACT.test(leaf.role) && !menu.has(leaf) && leaf !== opener && leaf.role !== 'checkbox').map(label);
          const texts = [...new Set(below.filter(leaf => !ACT.test(leaf.role)).map(said))];
          const head = `${pad}${node.line}${/ \[id=\w+\]/.exec(opener?.line ?? '')?.[0] ?? ''}: `;
          // two rows in full show what a row offers; the next ones say what they are, which is what a list is searched for
          const full = nodes.slice(0, i).filter(n => n.role === 'row' && n.kids.flatMap(leaves).some(leaf => leaf.role !== 'columnheader')).length < 2 || open.length;
          kept.push(full ? `${head}${texts.join(', ')}${buttons.length ? `. Buttons: ${buttons.join(', ')}` : ''}${open.length ? `. Menu open: ${open.join(', ')}` : ''}` : `${head}${texts.slice(0, 2).join(', ')}`);
        } else if (brief && node.role === 'columnheader') {
          let j = i;
          while (nodes[j + 1]?.role === 'columnheader') j++;
          kept.push(`${pad}- columns: ${nodes.slice(i, j + 1).map(said).join(', ')}`);
          i = j;
        } else {
          // an id only where it is used: on what can be clicked, typed in or hovered, and on dialogs
          kept.push(pad + (brief && PLAIN.test(node.role) ? node.line.replace(/ \[id=\w+\]/, '') : node.line));
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
    // every row calls its menu button "kebab menu": the row is what tells them apart
    const row = i => {
      for (let j = i - 1, level = indent(lines[i]); j >= 0; j--) {
        if (indent(lines[j]) >= level) continue;
        level = indent(lines[j]);
        if (parse(lines[j]).role === 'row') return parse(lines[j]).name;
      }
    };
    const found = lines.map((line, i) => ({ ...parse(line), i })).filter(p => p.id && p.role === 'button' && /menu|more|kebab/i.test(p.name ?? '')).slice(0, 4);
    if (!found.length) return '';
    return ` It may be in a menu (click one), or on the page of the item (click its name):\n${found.map(p => `  ${p.id}  ${p.name}${row(p.i) ? ` of row "${row(p.i).slice(0, 60)}"` : ''}`).join('\n')}`;
  };

  /**
   * A row whose icon comes from an extension says so: pictures are not in the tree, and the model cannot see them.
   * The app gives such an icon the class podman-desktop-icon-<id>; it is drawn when its character is set and its font loaded.
   */
  async function icons(text) {
    const found =
      (await js(`[...document.querySelectorAll('[role="row"] [class*="podman-desktop-icon-"]')].map(el => {
        const before = getComputedStyle(el, '::before');
        const family = before.fontFamily.split(',')[0].replace(/["']/g, '').trim();
        const font = [...document.fonts].find(f => f.family.replace(/["']/g, '') === family);
        const drawn = !/^(none|normal|"")$/.test(before.content) && font?.status === 'loaded';
        return [el.closest('[role="row"]').getAttribute('aria-label'), /podman-desktop-icon-([\\w-]+)/.exec(el.className.baseVal ?? el.className)[1], drawn ? 'drawn' : font ? 'not drawn: its font did not load' : 'not drawn: no font is registered for it'];
      })`)) ?? [];
    for (const [row, icon, state] of found) {
      if (!row) continue;
      const line = text.split('\n').find(l => l.trimStart().startsWith(`- row "${row}"`));
      if (line) text = text.replace(line, `${line.replace(/[:.,\s]+$/, '')}. Icon from an extension: ${icon} (${state})`);
    }
    return text;
  }

  /** What an extension of the app adds and where it shows, read from its manifest: the research a small model does not do. */
  function extension(name) {
    if (!name) throw new Error('not done: extension "<name>", for example extension "Kind"');
    const dirs = [[join(checkout, 'extensions'), 'bundled'], [join(home ?? '', 'plugins'), 'installed']];
    const manifests = dirs.flatMap(([dir, kind]) =>
      (existsSync(dir) ? readdirSync(dir) : []).flatMap(entry => {
        try {
          return [{ kind, ...JSON.parse(readFileSync(join(dir, entry, 'package.json'), 'utf8')) }];
        } catch {
          return [];
        }
      }),
    );
    const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const manifest =
      manifests.find(m => [m.name, m.displayName].some(n => key(n) === wanted)) ?? manifests.find(m => [m.name, m.displayName].some(n => key(n).includes(wanted)));
    if (!manifest) return `"${name}" is not in the app. Bundled or installed: ${manifests.map(m => m.displayName ?? m.name).join(', ')}.\nTo install it: click "Extensions", click "Catalog", install it, wait until look says it is installed, then run this again.`;
    const { icons: declared = {}, views = {}, menus = {}, commands = [] } = manifest.contributes ?? {};
    const PLACES = { 'icons/containersList': ['Containers', 'container'], 'icons/image': ['Images', 'image'] };
    const lines = [`Extension "${manifest.displayName ?? manifest.name}" (${manifest.kind}).`];
    const used = new Set();
    for (const [place, entries] of Object.entries(views)) {
      const [page, thing] = PLACES[place] ?? [];
      for (const { when = '', icon = '' } of Array.isArray(entries) ? entries : []) {
        const id = /\$\{(.*)\}/.exec(icon)?.[1] ?? icon;
        used.add(id);
        const label = /^\s*([\w./-]+) in (?:container|image)LabelKeys\s*$/.exec(when)?.[1];
        if (!page) lines.push(`- icon "${id}": used in ${place}, when ${when}`);
        else if (!label) lines.push(`- icon "${id}": shown in the ${page} list, on rows where: ${when}`);
        else {
          lines.push(`- icon "${id}": shown in the ${page} list, on ${thing}s that have the label ${label}`);
          lines.push(
            thing === 'container'
              ? `  To see it: podman run -d --name rvp-${id} --label ${label}=x quay.io/podman/hello, then click "Containers" and look "rvp-${id}"`
              : `  To see it: printf 'FROM quay.io/podman/hello\\nLABEL ${label}=x\\n' | podman build -t rvp-${id} -f - ., then click "Images" and look "rvp-${id}"`,
          );
        }
      }
    }
    for (const id of Object.keys(declared)) if (!used.has(id)) lines.push(`- icon "${id}": declared, not attached to a list (the extension uses it in its own pages or for its provider)`);
    const menuCount = Object.values(menus).flat().length;
    if (menuCount || commands.length) lines.push(`- also: ${commands.length} command(s), ${menuCount} menu item(s)`);
    if (lines.length === 1) lines.push('- it adds no icon.');
    lines.push('A row that has an icon from an extension says so in look: "Icon from an extension: <id> (drawn)".');
    return lines.join('\n');
  }

  async function look(what, limit = 1200, tries = 3) {
    const lines = (await tree()).split('\n');
    const first = (await where()).line;
    if (!what) return `${first}\n${cut(compact(lines, true), limit, HINT)}`;
    if (what === 'all') return `${first}\n${cut(lines.filter(line => !/^\s*- (generic|img) \[id=\w+\]:?$/.test(line)), 7000, HINT)}`;
    if (ID.test(what)) {
      const i = lines.findIndex(line => line.includes(`[id=${what}]`));
      // an old id costs the model a whole turn: answer with the window as it is
      if (i < 0) return `${what} is gone: the window changed.\n${first}\n${cut(compact(lines, true), limit, HINT)}`;
      return `${first}\n${cut(compact(within(lines, i)), 2000, HINT)}`;
    }
    const parts = new Map(); // first line of a part -> its lines
    // whole words first: USED is not UNUSED
    const word = new RegExp(`(?<!\\w)${what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'i');
    const has = lines.some(line => word.test(line)) ? line => word.test(line) : line => line.toLowerCase().includes(what.toLowerCase());
    // a menu link that merely contains the word counts only when nothing else does
    const inMenu = i => {
      for (let j = i, level = indent(lines[i]) + 1; j >= 0; j--) {
        if (indent(lines[j]) >= level) continue;
        level = indent(lines[j]);
        if (parse(lines[j]).role === 'navigation') return true;
      }
      return false;
    };
    const hits = lines.map((line, i) => i).filter(i => has(lines[i]));
    const wanted = hits.some(i => !inMenu(i)) ? hits.filter(i => !inMenu(i)) : hits;
    const covered = i => [...parts.keys()].some(start => start <= i && i < start + parts.get(start).length);
    for (const i of wanted) {
      if (covered(i)) continue; // each part once
      const block = blockOf(lines, i);
      if (block >= 0 && !covered(block)) parts.set(block, within(lines, block));
      else if (block < 0) parts.set(Math.max(0, i - 3), lines.slice(Math.max(0, i - 3), i + 7));
    }
    if (!parts.size && tries > 1) return (await sleep(1000), look(what, limit, tries - 1)); // it may still be loading
    if (!parts.size) return `${first}\n"${what}" is not in the window.${menus(lines)}`;
    return `${first}\n${cut([...parts.values()].flatMap(part => compact(part)), 2000, HINT)}`;
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
  const address = line => /^You are on page \S+/.exec(line)?.[0];
  const state = async () => Object.assign(compact((await tree()).split('\n'), true), { page: address((await where()).line) });

  /** Leading element ids of a command: `shot e12 e15 the two tabs` -> [['e12', 'e15'], ['the two tabs']] */
  const ids = args => {
    const found = [];
    while (ID.test(args[0] ?? '')) found.push(args.shift());
    return [found, args];
  };

  async function capture(stem, all = true) {
    const files = [];
    for (const [suffix, scheme] of all ? themes : themes.slice(0, 1)) {
      await ab('set', 'media', scheme);
      if (suffix) await sleep(300); // let the app repaint in the other theme
      await ab('screenshot', join(out, `${stem}${suffix}.png`));
      files.push(`${stem}${suffix}.png`);
    }
    if (themes.length > 1) await ab('set', 'media', 'light');
    moments.push(files);
  }

  /**
   * Screenshots of the window, one per theme, with the given elements (ids, or boxes already known)
   * outlined in red. Returns the first file and a note about ids that were not found.
   */
  async function shot(name, outlined = [], boxes = [], bothThemes = true) {
    const stem = `media/${String(++shots).padStart(2, '0')}-${slug(name)}`;
    const missing = [];
    boxes = [...boxes];
    for (const id of outlined) {
      await ab('scrollintoview', `@${id}`).catch(() => {});
      let box = await boxOf(id).catch(() => undefined);
      // the real input of a checkbox or a switch is one hidden pixel: the frame goes around what is drawn, its label
      if (box && (box.width < 4 || box.height < 4))
        box = (await js(`(() => { const el = ${AT(box)}; const r = (el?.closest('label') ?? el?.parentElement)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`)) ?? box;
      if (box) boxes.push(box);
      else missing.push(id);
    }
    // a frame drawn over the window where the element is: nothing of the app is restyled, and nothing can clip it.
    // At least 14 pixels: the real checkbox of a switch is one hidden pixel.
    if (boxes.length)
      await js(`(${JSON.stringify(boxes)}).forEach(b => { const w = Math.max(b.width, 14), h = Math.max(b.height, 14); document.body.insertAdjacentHTML('beforeend', '<div class="rvp-outline" style="position:fixed;left:' + (b.x - (w - b.width) / 2) + 'px;top:' + (b.y - (h - b.height) / 2) + 'px;width:' + w + 'px;height:' + h + 'px;border:3px solid red;box-sizing:border-box;pointer-events:none;z-index:2147483647"></div>'); })`);
    await capture(stem, bothThemes);
    await js(`document.querySelectorAll('.rvp-outline').forEach(el => el.remove())`);
    return [`${stem}.png`, missing.length ? ` (no element ${missing.join(', ')} in the window now: not outlined)` : ''];
  }

  /**
   * The window's own buttons (title bar, on Linux and Windows): Close would end the app, and with it the run.
   * They are the Close, Minimize and Maximize that sit next to each other.
   */
  const windowButtons = lines => {
    const named = lines.map(parse);
    const own = (p, i) => p.role === 'button' && /^(Close|Minimize|Maximize)$/.test(p.name ?? '') && named.some((q, j) => j !== i && Math.abs(j - i) <= 6 && indent(lines[j]) === indent(lines[i]) && /^(Minimize|Maximize)$/.test(q.name ?? ''));
    return new Set(named.filter(own).map(p => p.id));
  };
  /** The element a command names: an id from look, or the visible name of something in the window. */
  async function target(words, click = false) {
    // a name and an id together ("Run Image e1259"): the id is what was meant
    const given = words.flatMap(word => word.split(' ')).find(word => ID.test(word)) ?? words.join(' ').trim().replace(/^"(.*)"$/, '$1');
    if (ID.test(given)) {
      if (click && windowButtons((await tree()).split('\n')).has(given))
        throw new Error('not done: that is the window\'s own button, it would close the app. To leave a page click its "Close" or "Back"; to close a dialog press Escape.');
      return { id: given };
    }
    if (!given) throw new Error('say what: a name such as "Images", or an id such as e12.');
    let lines, all;
    const read = async () => {
      lines = (await tree()).split('\n');
      const own = windowButtons(lines); // never a match: click "Close" means the page's or the dialog's
      all = lines.map((line, i) => ({ ...parse(line), i })).filter(p => p.id && p.name && !own.has(p.id));
    };
    const named = (name, role) => {
      const wanted = name.toLowerCase().replace(/^"(.*)"$/, '$1');
      const exact = all.filter(p => p.name.toLowerCase() === wanted && (!role || p.role === role));
      // a part of a name counts when it starts the name or is a good share of it: "Disabled" is not the
      // switch whose long description happens to contain that word
      const part = all.filter(p => (p.name.toLowerCase().startsWith(wanted) || (p.name.toLowerCase().includes(wanted) && wanted.length >= 0.4 * p.name.length)) && (!role || p.role === role));
      // a click on the name of a row means its item: the button "name id tag" in it opens the page, the row opens nothing
      if (click && exact.length && !exact.some(p => ACT.test(p.role))) return part;
      return exact.length ? exact : part;
    };
    const [, role, rest] = /^(\w+) (.+)$/.exec(given) ?? []; // click link "Extensions"
    let found = [];
    // a list that is still loading: look again for a few seconds before saying it is not there
    for (let tries = 0; tries < 4 && !found.length; tries++) {
      if (tries) await sleep(1000);
      await read();
      found = named(given);
      if (!found.length && rest) found = named(rest, role);
    }
    if (found.some(p => ACT.test(p.role))) found = found.filter(p => ACT.test(p.role));
    if (!found.length) throw new Error(`nothing is named "${given}" in the window.${menus(lines) || ' Run look to see what is there.'}`);
    if (found.length > 1) {
      const place = i => {
        const block = blockOf(lines, i);
        const { role, name } = block >= 0 && block !== i ? parse(lines[block]) : {};
        return name ? ` in ${role} "${name.slice(0, 60)}"` : '';
      };
      throw new Error(`${found.length} elements are named "${given}". Use the id of the one you mean:\n${found.slice(0, 8).map(p => `  ${p.id}  ${p.role} "${p.name}"${place(p.i)}`).join('\n')}`);
    }
    return { id: found[0].id };
  }
  /** The answer to an action: where the app is now, and only what changed in the window. */
  const after = async (done, before) => {
    // a page fills in over a few seconds (lists load): wait until two views in a row say the same
    let now = await state();
    const settle = async () => {
      for (let tries = 0; tries < 8; tries++) {
        await sleep(500);
        const next = await state();
        const same = next.length === now.length && next.every((line, i) => key(line) === key(now[i]));
        now = next;
        if (same) break;
      }
    };
    await settle();
    // the address changes before the new page is drawn: what was read may still be the old page
    if (before.page !== now.page) await settle();
    const first = (await where()).line;
    // another page: what look would say, so that no second command is needed (a diff cut short hid the buttons)
    if (before.page !== address(first)) {
      // without the navigation line (it never changes), and only the start of the tab's content: its buttons are above it
      const content = now.findIndex(line => line.startsWith('- region "Tab Content"'));
      const was = new Set(before.map(key)); // a menu that was already there is not printed again
      const page = now.filter((line, i) => !(line.trim().startsWith('- navigation') && was.has(key(line))) && (content < 0 || i <= content + 6));
      return `${done}\n${first}\n${cut(page, 900, HINT)}`;
    }
    const { appeared, gone } = changes(before, now);
    if (!appeared.length && !gone.length) return `${done}\n${first}\nNothing changed in the window.`;
    // A line that only changed state ([disabled], [expanded]...) is not new: a dialog opening changes a
    // dozen of them in the background. Only a button or a field that changed state is worth one line.
    const bare = line => line.trim().replace(/ \[[^\]]*\]/g, '').replace(/:$/, '');
    const had = new Map();
    for (const line of before) had.set(bare(line), (had.get(bare(line)) ?? 0) + 1);
    const fresh = [], changed = [];
    for (const i of appeared) {
      if (!had.get(bare(now[i]))) { fresh.push(i); continue; }
      had.set(bare(now[i]), had.get(bare(now[i])) - 1);
      if (ACT.test(parse(now[i]).role ?? '')) changed.push(now[i].trim());
    }
    const still = new Set(now.map(bare));
    const left = gone.filter(line => !still.has(bare(line)));
    // one control went and one of the same kind came: it changed its name, as a dropdown does with its value
    const [was, is] = [left.filter(line => ACT.test(parse(line).role ?? '')), fresh.filter(i => ACT.test(parse(now[i]).role ?? ''))];
    if (was.length === 1 && is.length === 1 && parse(was[0]).role === parse(now[is[0]]).role) {
      changed.push(`${bare(was[0]).replace(/^- /, '')} → ${now[is[0]].trim().replace(/^- /, '')}`);
      left.splice(left.indexOf(was[0]), 1);
      fresh.splice(fresh.indexOf(is[0]), 1);
    }
    // new lines, grouped under the nearest thing they are in that was already there
    const groups = new Map();
    for (const i of fresh) {
      let inside = -1;
      for (let j = i - 1, level = indent(now[i]); j >= 0 && inside < 0; j--) {
        if (indent(now[j]) >= level) continue;
        level = indent(now[j]);
        if (!fresh.includes(j)) inside = j;
      }
      groups.set(inside, [...(groups.get(inside) ?? []), i]);
    }
    const parts = [];
    for (const [inside, lines] of groups) {
      const least = Math.min(...lines.map(i => indent(now[i])));
      parts.push(inside < 0 ? 'Appeared:' : `Appeared in ${bare(now[inside]).replace(/^- /, '')}:`, ...lines.map(i => `  ${now[i].slice(least)}`));
    }
    if (changed.length) parts.push(`Changed: ${changed.slice(0, 5).map(line => line.replace(/^- /, '')).join('; ')}`);
    if (left.length) parts.push(`Gone: ${left.length} lines (${left[0].replace(/^- /, '').slice(0, 60)}${left.length > 1 ? ', ...' : ''})`);
    const body = parts.length ? cut(parts, 600, 'Use: look to see the window.') : 'Nothing changed in the window.';
    // a loop gives the same answer again and again: say so in one line
    const told = body.replace(/ \[id=\w+\]/g, '');
    const same = lastChange.get(done) === told && parts.length > 2;
    lastChange.set(done, told);
    return `${done}\n${first}\n${same ? 'Same result as the last time you did this.' : body}`;
  };
  const hoverOne = async (id, alone = true) => {
    await act('hover', id);
    await sleep(900); // tooltips appear after a delay
    const box = await boxOf(id);
    // the side of the tooltip comes from the two rectangles
    const seen =
      (await js(`(() => {
        const box = ${JSON.stringify(box)};
        const el = ${AT(box)};
        const tip = [...document.querySelectorAll('[role="tooltip"]')].find(t => t.getClientRects().length && t.textContent.trim());
        const at = tip?.getBoundingClientRect();
        return {
          title: el?.getAttribute('title') ?? null,
          disabled: el?.disabled === true || el?.getAttribute('aria-disabled') === 'true',
          menu: !!el?.hasAttribute('aria-haspopup'),
          tip: tip?.textContent.trim() ?? null,
          side: !at ? '' : at.bottom <= box.y + 2 ? 'above' : at.top >= box.y + box.height - 2 ? 'below' : at.right <= box.x + 2 ? 'on the left of' : 'on the right of',
        };
      })()`)) ?? {};
    // The picture is taken now, with the tooltip on screen: at the verdict it is gone (after Escape, after a
    // click), and the model outlined the wrong thing. Named by what it shows: that is its caption in the comment.
    // In the light theme only: the tooltip is what matters, and twice the pictures say nothing more. Of the
    // buttons of a row, those that show something.
    if (alone || seen.tip || seen.title)
      await shot(`hover ${describe(id)?.name ?? ''}: ${seen.tip ? `tooltip ${seen.tip}` : seen.title ? `title ${seen.title}` : 'no tooltip'}`, [], [box], false).catch(() => {});
    return seen;
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
    js(`(() => {
      const seen = [];
      const read = () => [...document.querySelectorAll('[role="tooltip"]')].filter(t => t.getClientRects().length && t.textContent.trim()).map(t => '"' + t.textContent.trim() + '"').join(', ') || 'gone';
      const timer = setInterval(() => seen.at(-1) !== read() && seen.push(read()), 50);
      globalThis.__rvpTooltip = () => (clearInterval(timer), seen);
      return true;
    })()`);
  const watchedTooltip = async () => {
    const seen = (await js(`globalThis.__rvpTooltip?.() ?? []`)) ?? [];
    return seen.length > 1 ? `Tooltip during the click: ${seen.join(' → ')}` : '';
  };

  const commands = {
    // `look cell e59`: the id is what was meant
    look: async (...words) => icons(await look(words.find(word => ID.test(word)) ?? (words.join(' ') || undefined))),
    extension: async (...words) => extension(words.join(' ').trim()),
    click: async (...words) => {
      const { id } = await target(words, true);
      const [label, before] = [what(id), await state()];
      await watchTooltip();
      await act('click', id);
      const chosen = describe(id);
      const answer = await after(`clicked ${label}.`, before);
      // A choice in a dropdown goes away with its list, and the control takes its name: say so, the
      // list of changes does not (the same name was there before, as the choice).
      const same = chosen ? snapshot.replace(/\[ref=/g, '[id=').split('\n').map(parse).filter(p => p.role === chosen.role && p.name === chosen.name) : [];
      const shows = same.length === 1 && same[0].id !== id ? `The control now shows "${chosen.name}" [id=${same[0].id}].` : '';
      return [answer, shows, await watchedTooltip()].filter(Boolean).join('\n');
    },
    hover: async (...words) => {
      // a row has no id of its own: it is named, and its buttons are hovered one by one
      let lines = (await tree()).split('\n');
      const named = words.join(' ').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
      const row = lines.findIndex(line => parse(line).role === 'row' && parse(line).name?.toLowerCase() === named);
      const id = row >= 0 ? undefined : (await target(words)).id;
      const label = row >= 0 ? `row "${parse(lines[row]).name}"` : what(id);
      if (row < 0) lines = (await tree()).split('\n');
      const i = row >= 0 ? row : lines.findIndex(line => line.includes(`[id=${id}]`));
      // on a cell or a toolbar: every button in it, one line each
      const inside = i < 0 || ACT.test(parse(lines[i]).role ?? '') ? [] : within(lines, i).slice(1).map(parse).filter(p => p.id && /^(button|link)$/.test(p.role)).slice(0, 6);
      if (inside.length) {
        const rows = [];
        for (const p of inside) {
          const seen = await hoverOne(p.id, false).catch(() => undefined);
          const twice = inside.filter(q => q.name === p.name).length > 1; // the id only tells apart two buttons with one name
          rows.push(`  ${p.role} "${p.name ?? ''}"${twice ? ` [id=${p.id}]` : ''}${seen?.disabled ? ' (disabled)' : ''}${seen?.menu ? ' (opens a menu)' : ''}: ${seen ? tooltipOf(seen, p.role) : 'could not be hovered'}`);
        }
        return `hovering ${label}: ${inside.length} buttons inside\n${rows.join('\n')}`;
      }
      const seen = await hoverOne(id);
      return `hovering ${label}${seen.disabled ? ' (disabled)' : ''}\n  ${tooltipOf(seen, describe(id)?.role ?? 'element')}`;
    },
    fill: async (first, ...text) => {
      const { id } = await target([first]);
      const [label, before] = [what(id), await state()];
      await act('fill', id, text.join(' '));
      return after(`filled ${label}.`, before);
    },
    press: async key => {
      const before = await state();
      await ab('press', key);
      return after(`pressed ${key}.`, before);
    },
    eval: async (...args) => {
      let [targets, code] = ids([...args]);
      code = code.join(' ');
      const print = async expression => {
        const text = await ab('eval', expression);
        try {
          return JSON.stringify(JSON.parse(text)).slice(0, 500); // on one line
        } catch {
          return text.slice(0, 500) || 'undefined';
        }
      };
      const known = id => snapshot.includes(`[ref=${id}]`);
      const refuse = id => new Error(`${id} is not an id in the page: ids exist only for these commands. Use: look ${id} (what is inside it), hover ${id} (its tooltip), or eval ${id} "el => el.getAttribute('title')"`);
      // `e561 => ...`: a function on that element, as small models write it
      const [arrow, param] = /^\s*(e\d+)\s*=>/.exec(code) ?? [];
      if (!targets.length && param && known(param)) {
        if (new RegExp(`['"#=\\[]\\s*${param}\\b`).test(code.slice(arrow.length))) throw refuse(param);
        targets = [param];
      }
      if (targets.length) {
        return print(`(${code})(${AT(await boxOf(targets[0]))})`);
      }
      const used = (code.match(/\be\d+\b/g) ?? []).find(known);
      if (used) throw refuse(used);
      return print(code);
    },
    shot: async (...args) => {
      const [outlined, name] = ids(args);
      // not in the instructions any more: a model used it as its click, seven times in one run
      await shot(readable(name.join(' ')) || 'screenshot', outlined);
      return `Screenshots are taken for you at each verdict. Nothing was clicked.${outlined[0] ? ` To click it: click ${outlined[0]}` : ''}`;
    },
    size: async (...args) => {
      const words = args.flatMap(a => (/^\d+x\d+$/i.test(a) ? a.toLowerCase().split('x') : [a]));
      const numbers = words.filter(w => /^\d+$/.test(w)).map(Number);
      const sizes = [];
      for (let i = 0; i < numbers.length; i += 2) sizes.push([numbers[i], numbers[i + 1]]);
      if (!sizes.length) sizes.push([800, 600], [1280, 800], [1920, 1080]);
      if (sizes.some(([w, h]) => !(w >= 400 && w <= 2560 && h >= 300 && h <= 1600)))
        throw new Error('not done: size, or size <width> <height>, for example size 800 600');
      const label =
        readable(words.filter(w => !/^\d+$/.test(w)).join(' ')) ||
        ((await js(`(document.querySelector('h1, [role="heading"]')?.textContent ?? '').trim().slice(0, 40)`)) || `page ${page}`);
      const before = await js('[innerWidth, innerHeight]');
      const facts = [];
      for (const [w, h] of sizes) {
        await ab('set', 'viewport', String(w), String(h));
        await sleep(500); // let the app lay itself out again
        // what a text or a named control loses on its right side, to the window or to the box that clips it
        const cut =
          (await js(`(() => {
            const clips = new Map();
            const clip = el => {
              if (!el) return innerWidth;
              if (!clips.has(el)) clips.set(el, Math.min(clip(el.parentElement), getComputedStyle(el).overflowX === 'visible' ? Infinity : el.getBoundingClientRect().right));
              return clips.get(el);
            };
            const found = new Map();
            for (const el of document.body.querySelectorAll('*')) {
              const name = (el.getAttribute('aria-label') ?? [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ')).trim().slice(0, 40);
              if (!name || !el.getClientRects().length) continue;
              const r = el.getBoundingClientRect(), edge = clip(el.parentElement);
              if (r.width && r.left < edge && r.right > edge + 2 && !found.has(name)) found.set(name, [Math.round(r.right - edge), edge < innerWidth - 2]);
            }
            return [...found].map(([name, [by, boxed]]) => [name, by, boxed]);
          })()`)) ?? [];
        // a strip of cards that scrolls sideways always hides its last card: said apart from what the window cuts
        const list = items => `${items.slice(0, 3).map(([name, by]) => `"${name}" (by ${by} px)`).join(', ')}${items.length > 3 ? `, and ${items.length - 3} more` : ''}`;
        const [windowCut, boxCut] = [cut.filter(c => !c[2]), cut.filter(c => c[2])];
        facts.push(
          `${w}x${h}: ${windowCut.length ? `cut off by the right edge of the window: ${list(windowCut)}` : 'nothing is cut off by the window'}` +
            (boxCut.length ? `; partly hidden inside a box that scrolls sideways or clips: ${list(boxCut)}` : ''),
        );
        await capture(`media/${String(++shots).padStart(2, '0')}-${slug(`${label} at ${w}x${h}`)}`);
      }
      // back to the size the window had: the next claim is not checked at the last size by accident
      if (before) await ab('set', 'viewport', String(before[0]), String(before[1]));
      const n = open()[0];
      return `${(await look()).split('\n')[0]}\n${facts.join('\n')}\nScreenshots taken ("${label}").${n ? ` Give the verdict now: pass ${n} "..." or fail ${n} "..."` : ''}`;
    },
    restart: async (...folders) => (await stop(), await start(folders), `restarted with ${folders.length} extension folder(s).`),
    stop: async () => (await stop(), setTimeout(() => process.exit(0), 100), 'stopped.'),
  };
  // The model is not waited for: a claim that used its commands or its minutes is closed here, with a
  // screenshot of the window as it is. A run always ends with a report, whatever the model does.
  // 20: at one command a minute, 12 closed a claim the moment the model reached the page that proves it
  const MINUTES = Number(process.env.RVP_CLAIM_MINUTES) || 20;
  let said = ''; // every answer so far, to check a pass against what the model was really told
  let since; // when the work on the current claim started (its first action on the app)
  const giveUp = async why => {
    const n = open()[0];
    await shot(`claim ${n} not decided`).catch(() => undefined);
    verdicts.set(n, { claim: claims[n - 1], status: 'skipped', reason: `The model gave no verdict ${why}. The screenshot shows the window at that moment.`, screenshots: moments.slice(-8).flat() });
    moments = [];
    sinceVerdict = 0;
    since = undefined;
    writeFileSync(join(out, 'checks.json'), JSON.stringify(claims.map((_, i) => verdicts.get(i + 1)).filter(Boolean), null, 2));
    if (!open().length) writeFileSync(join(out, 'done'), '');
    // after the answer of the command that was running: that answer may be the proof
    return `\nClaim ${n} was closed as skipped: no verdict ${why}. If the answer above shows it, send pass ${n} or fail ${n} now${open().length ? `; if not, go on with claim ${open()[0]}` : ''}.`;
  };
  commands.claims = async () => claims.map((c, i) => `${i + 1}. ${c}`).join('\n');
  for (const [verb, status] of [['pass', 'passed'], ['fail', 'failed'], ['skip', 'skipped']]) {
    commands[verb] = async (...args) => {
      const command = JSON.stringify(args);
      // the number of the claim: 1, #1, "claim 1"; not needed when there is one claim
      const words = [...args];
      const at = words.findIndex(word => /^(claim )?#?\d+[.:]?$/i.test(word.trim()));
      const n = at >= 0 ? Number(/\d+/.exec(words[at])[0]) : claims.length === 1 ? 1 : 0;
      if (at >= 0) words.splice(at, 1);
      // then the elements to outline: pass 1 e432 "what you saw" (the ids were lost when the number came first)
      const [outlined, rest] = ids(words);
      if (!claims[n - 1]) throw new Error(`not recorded: say which claim, by its number: ${verb} 1 "<what you saw>". The claims:\n${await commands.claims()}`);
      const claim = claims[n - 1];
      // A verdict about a tab that is not the open one is sent back once; the same command again is accepted.
      const task = claim.toLowerCase();
      const { tabs } = status === 'skipped' || refused === command ? { tabs: [] } : await where();
      const named = tabs.find(t => !t.open && task.includes(t.name.toLowerCase()));
      const shown = tabs.filter(t => t.open);
      if (named && !shown.some(t => task.includes(t.name.toLowerCase()))) {
        refused = command;
        await tree();
        const [, id] = new RegExp(`"${named.name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snapshot) ?? [];
        throw new Error(
          `not recorded: the claim is about "${named.name}", but the open tab is ${shown.map(t => `"${t.name}"`).join(', ') || 'another one'}.\n` +
            `Click the "${named.name}" tab${id ? ` (id ${id})` : ''}, look, then give your verdict.\n` +
            `If the open tab really is the right place, send the same command again.`,
        );
      }
      // A pass is checked against what the tool printed; sent back once, the same command again is accepted.
      // ponytail: two cheap checks. A quoted text of the claim must have been printed; the reason must not be the claim again.
      if (status === 'passed' && refused !== command) {
        const missing = (claim.match(/"[^"]{3,}"/g) ?? []).map(q => q.slice(1, -1)).find(q => !said.includes(q.toLowerCase()));
        const words = text => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
        const [mine, theirs] = [words(rest.join(' ')), words(claim)];
        // words of the claim are fine when an answer printed them too: four words in a row of the reason, as printed
        const told = rest.join(' ').toLowerCase().split(/\s+/);
        const quoted = told.some((_, i) => i + 4 <= told.length && said.includes(told.slice(i, i + 4).join(' ')));
        const parrot = !quoted && mine.size > 0 && [...mine].filter(w => theirs.has(w)).length >= 0.8 * mine.size;
        if (missing || parrot || !mine.size) {
          refused = command;
          throw new Error(
            missing
              ? `not recorded: no answer ever printed "${missing}", so you did not see it. Send fail ${n} or skip ${n} with what you saw; the same command again only if you are sure.`
              : `not recorded: the reason repeats the claim. Write what an answer printed that proves it (quote it), or send fail ${n} or skip ${n}.`,
          );
        }
      }
      const note = status === 'skipped' ? '' : (await shot(`claim ${n} ${status}`, outlined))[1];
      sinceVerdict = -1; // this command is counted right after
      since = undefined;
      // a second verdict for a claim replaces the first: a wrong one is corrected, not argued about
      const again = verdicts.has(n);
      // the last hovers, then the window at the verdict
      verdicts.set(n, { claim, status, reason: readable(rest.join(' ')), screenshots: moments.slice(-8).flat() });
      moments = [];
      writeFileSync(join(out, 'checks.json'), JSON.stringify(claims.map((_, i) => verdicts.get(i + 1)).filter(Boolean), null, 2));
      // for the step that runs the model: nothing is left to do
      if (!open().length) writeFileSync(join(out, 'done'), '');
      return `${again ? 'replaced' : 'recorded'}: claim ${n} ${status}${note}`;
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
          // going in circles, or too long on one claim: it is closed without the model, and the command goes on
          let closed = '';
          const verdict = ['pass', 'fail', 'skip', 'stop', 'restart', 'claims'].includes(name);
          if (['click', 'hover', 'fill', 'press'].includes(name)) since ??= Date.now();
          if (open().length && !verdict) {
            if (sinceVerdict >= (verdicts.size ? 15 : 25)) closed = await giveUp(`after ${sinceVerdict} commands`);
            else if (since && Date.now() - since > MINUTES * 60_000) closed = await giveUp(`after ${MINUTES} minutes`);
          }
          if (!commands[name]) throw new Error(`unknown command "${name}". The commands are: ${Object.keys(commands).filter(c => c !== 'stop').join(', ')}. Example: node rvp/pd.mjs click "Images"`);
          let reopened = '';
          if (!alive && name !== 'stop' && name !== 'restart') {
            // the window was closed (by a person, or the app crashed): open a fresh one rather than fail every command
            await stop();
            await start(folders);
            reopened = 'The app window had closed, so the app was started again: it is back on the Dashboard.\n';
          }
          text = reopened + (await commands[name](...rest)) + closed;
        } catch (error) {
          ok = false;
          text = `error: ${String(error.message ?? error).split('\n').slice(0, 6).join('\n')}`;
        }
        if (lost && name !== 'stop') text = `Your previous command (${lost.command}) was done; its answer, which your timeout cut:\n${lost.text}\n\nAnswer to this command:\n${text}`;
        lost = undefined;
        // a screenshot is not a step of the work: it does not use up the commands
        if (name !== 'shot' && name !== 'claims') sinceVerdict++;
        if (name !== 'stop' && name !== 'claims') {
          if (open().length && sinceVerdict >= (verdicts.size ? 8 : 12)) text += `\n${sinceVerdict} commands since the last verdict: record pass, fail or skip now.`;
          text += `\n${left()}`;
        }
        if (!['pass', 'fail', 'skip', 'claims'].includes(name)) said += `${text.toLowerCase()}\n`;
        appendFileSync(join(out, 'actions.log'), `$ ${[name, ...rest].join(' ')}\n${text.slice(0, 600)}\n\n`);
        // one line per action, for whoever watches the run
        const lines = text.split('\n');
        const here = lines.find(line => line.startsWith('You are on'));
        const shown = here && /^(clicked|filled|pressed) /.test(lines[0]) ? here : [...new Set([lines[0], here])].filter(Boolean).join(' ');
        appendFileSync(join(out, 'progress.log'), `${new Date().toISOString().slice(11, 19)} ${(step ?? [name, ...rest].join(' ')).slice(0, 160)} → ${shown.slice(0, 200)}\n`);
        // what the comment shows: actions only, in plain words
        if (step) appendFileSync(join(out, 'steps.log'), `${step.replace(/\s+/g, ' ').slice(0, 300)}${ok ? '' : ' (did not work)'}\n`);
        if (request.socket.destroyed) lost = { command: [name, ...rest].join(' ').slice(0, 80), text: text.slice(0, 800) };
        response.writeHead(ok ? 200 : 400).end(text);
      });
    });
  }).listen(PORT, '127.0.0.1', () => console.log('ready'));
}
