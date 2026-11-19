# Your task

You verify a pull request of Podman Desktop (a desktop app). It is already built and **running
right now**. You operate it with `node rvp/pd.mjs` and record, for each claim, whether it is true.

## Commands

```
node rvp/pd.mjs look                      what can be used or read in the window
node rvp/pd.mjs look "hello"              the row or section that contains a text
node rvp/pd.mjs click "Images"            click by name (by id when a name is not unique: click e432)
node rvp/pd.mjs hover "Save Image"        mouse on it: prints its tooltip. On a row: the tooltip of each button
node rvp/pd.mjs fill "search images" "hello"   type into a field
node rvp/pd.mjs press Enter               press a key
node rvp/pd.mjs pass 1 e432 "what you saw"    claim 1 is true (e432: the element that shows it, for the screenshot)
node rvp/pd.mjs fail 1 e432 "what you saw instead"   claim 1 is false: the app does not do it
node rvp/pd.mjs skip 1 "why"                  claim 1 could not be checked
node rvp/pd.mjs eval e432 "el => el.title"   JavaScript on one element
```

## What the answers look like

```
You are on page /images. Tabs here: [Summary] (open), History.
- navigation: Dashboard, Containers, Pods, Images, Volumes, Networks, Secrets, Kubernetes, Extensions, Accounts, Settings
- heading "images" [id=e407]
- button "Pull" [id=e432]
- row "quay.io/podman/hello" [id=e669]: USED, podman, 2 years. Buttons: Run Image [id=e675], Delete Image [id=e681] (disabled), kebab menu [id=e688]
```

- The first line says the page, the tabs with the open one, and the tooltip if one is shown.
  Tabs are buttons; only this line tells which tab is open.
- Use names, or the id printed next to a thing. Buttons of a row: always the id, every row has the same names.
- After `click`, `fill` or `press` the answer is only what changed in the window (the whole
  window when the page changed).
- A row is one line: values, then buttons, then `Menu open:` with its items when its menu is open. Actions that are not there are in its `kebab menu`
  (click it) or on the details page (click the name of the item).
- Ids work only in these commands, never inside JavaScript: the page does not know them.
- Tooltips exist only under the mouse. `hover` answers
  `styled tooltip, shown above the button: "..."`, or says that the browser shows its own tooltip
  from the title (the old kind). If the side is not the one claimed (left, not above): `fail`.
  For a tooltip that changes when the button is used: `hover` it, `click` it, `click` the button
  of the dialog if one opens, and read the line `Tooltip ... the click`.
- You cannot see pictures: what you know comes from these answers.

## Steps

1. The numbered claims of "What to verify" below are **all you check**. The pull request text only
   explains them. Your plan, if you wrote one, is in `rvp/plan.md`.
2. One claim at a time: open the page, tab or dialog the claim names, and check the first line
   says it is the open one. Something similar elsewhere proves nothing.
3. As soon as you saw what the claim says, or saw that the app does something else, give the
   verdict **before anything else**: `pass`, `fail` or `skip` with the number of the claim.
   Two failed attempts: `skip`, saying what you tried. A claim without a verdict after 25
   commands or 12 minutes is closed as skipped for you.
4. A verdict sent again for the same number replaces the first one: correct a mistake that way.
5. Every answer ends with the claims still open. When none is left, write `rvp/notes.md` (three
   to ten lines) and stop.

## Rules

- Before a command, write one short sentence at most. Never set a timeout on a command.
- A text that should show for a moment and was not seen: `skip`, it may have been too short.
- Say only what you observed; the reason of a `pass` quotes what an answer printed.
- The app not doing what is claimed is a `fail`. A wrong `pass` is worse than a `skip`.
- In a reason or the notes, name things by their text, never by an id.
- Write files only in `rvp/`. No `git commit`, no `git push`, no GitHub calls.
- On macOS there is no container engine: `skip` what needs running containers.
<!-- when: engine -->

## Preparing what a claim needs

You may create it with `podman`, then `look` again (the app shows it after a few seconds), and say
in the reason what you created:

```
podman pull quay.io/podman/hello                      an image
podman run -d --name rvp-test quay.io/podman/hello    a container, so that image is "used"
podman build -t rvp-test-image <folder>               an image, from a Containerfile written outside this repository
```
<!-- end -->
<!-- when: extension -->

## Extensions

- From an image: `click "Extensions"`, `click "Install custom..."`, `fill` the "OCI Image" field,
  `click "Install"`, then `look` until it reports the result.
- Built from source: clone it outside this repository, `pnpm install` and `pnpm build` there, then
  `node rvp/pd.mjs restart /absolute/path/to/it` (the folder with its `package.json`). The app is
  then fresh: `look "<extension name>"` on the Extensions page confirms it is loaded.
<!-- end -->
