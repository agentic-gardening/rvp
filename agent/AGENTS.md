# Your task

You verify a pull request of Podman Desktop (a desktop app). The pull request is already built and
**the app is running right now**. You operate it with one command, `node rvp/pd.mjs`, look at what
it shows, and record for each claim whether it is true.

## Commands

```
node rvp/pd.mjs look                 print what the window contains
node rvp/pd.mjs look "Kind"          print only the lines around a text (use this on big pages)
node rvp/pd.mjs click e114           click the element with id e114
node rvp/pd.mjs fill e77 "some text" type into a field
node rvp/pd.mjs press Enter          press a key
node rvp/pd.mjs eval "document.title"   run JavaScript in the page and print the value
node rvp/pd.mjs shot e461 "the Local extensions tab"   save a screenshot with element e461 outlined in red
node rvp/pd.mjs pass e461 "<claim>" "<what you saw that proves it>"
node rvp/pd.mjs fail e461 "<claim>" "<what you saw instead>"
node rvp/pd.mjs skip "<claim>" "<why it could not be checked>"
node rvp/pd.mjs restart /path/to/extension   restart the app with locally built extensions
```

## Reading the window

The first line of `look` says where you are: the page, and the tabs of that page with the open one.
Then comes a tree. Each line is `role "name" [id=...]`, sometimes followed by its text:

```
You are on page /extensions. Tabs here: [Installed] (open), Catalog, Local extensions.
- link "Extensions" [id=e114]
- button "Local extensions" [id=e421]
- region "podman-desktop.kind" [id=e442]:
    - button "kind extension details" [id=e451]:
      - generic [id=e452]: Kind extension
    - status "Extension status" [id=e455]:
      - generic [id=e459]: Installed
```

- To click something, use its id, copied exactly as printed: `node rvp/pd.mjs click e114`. Ids look
  like `e114` or `f1e114`.
- Tabs are buttons. Only the first line tells which tab is open. In the example the open tab is
  Installed: what you see is the Installed tab. To see the Local extensions tab, click it
  (`node rvp/pd.mjs click e421`) and check that the first line now says `[Local extensions] (open)`.
- **Ids change after every click, fill or press.** The command prints the new window: take ids from
  the newest output only.
- You cannot see pictures. Everything you know about the app comes from `look` and `eval`.
- Use `eval` for things the tree does not say, such as a scrollbar:
  `node rvp/pd.mjs eval "(() => { const el = document.querySelector('[aria-label=\"content\"]'); return el.scrollHeight > el.clientHeight })()"`

The main navigation links are: Dashboard, Containers, Pods, Images, Volumes, Networks, Secrets,
Kubernetes, Extensions, Accounts, Settings.

## Steps

1. Read "What to verify" and the pull request text at the end of this file. List the claims to check.
2. For each claim: go to the place the claim names. If it names a page, a tab or a dialog, open
   that page, that tab or that dialog first, and check on the first line of `look` that it is the
   open one. Something that looks similar on another tab proves nothing. Then decide from what is printed.
3. Show the evidence. People will read your screenshots, so each one must show the exact part of
   the window that proves or disproves the claim: `node rvp/pd.mjs shot <id> "<what it shows>"`,
   with the id of that element. If the claim is about a change (something appears, moves, opens),
   take one `shot` before the action and one after.
4. Record exactly one verdict per claim with `pass`, `fail` or `skip`, giving the id of the element
   that decides it: `node rvp/pd.mjs pass <id> "<claim>" "<reason>"`. One more screenshot is taken at
   that moment, so record the verdict while the window shows the evidence. Leave the id out only
   when no element shows it (for example a value you got from `eval`).
5. When every claim has a verdict, write `rvp/notes.md` (three to ten lines: what you checked and
   what you found) and stop.

## Rules

- Ids such as `e114` are only for commands. In a claim, a reason or the notes, never write an id:
  name things by their text, like a person would ("the Local extensions tab", "the search field").
- Say only what you observed. The reason of a `pass` must quote what `look` or `eval` printed.
- If the app does not do what the pull request says, that is a `fail`. Never record a `pass` to be nice.
- If you tried and cannot tell, use `skip`. A wrong `pass` is worse than a `skip`.
- Write files only inside `rvp/`. Never change another file of the repository.
- No `git commit`, no `git push`, no GitHub calls. Someone else publishes your result.

## Extensions

- **From an image**: click the link "Extensions", click the button "Install custom...", `fill` the
  "OCI Image" field with the image name, click "Install", then `look` until it reports the result.
- **Built from source**: clone the extension outside this repository (for example into `../ext-name`),
  run `pnpm install` and `pnpm build` in it, then
  `node rvp/pd.mjs restart /absolute/path/to/ext-name` (the folder holding the extension's
  `package.json`; several folders can be given). After a restart the app is fresh: open the
  Extensions page and `look "<extension name>"` to confirm it is loaded.

## Limits

- On macOS there is no container engine: `skip` any claim that needs running containers.
