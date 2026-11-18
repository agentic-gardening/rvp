# Your task

You verify a pull request of Podman Desktop (a desktop app). It is already built and **running
right now**. You operate it with `node rvp/pd.mjs` and record, for each claim, whether it is true.

## Commands

```
node rvp/pd.mjs look                      what can be used or read in the window
node rvp/pd.mjs look "hello"              the row or section that contains a text
node rvp/pd.mjs look e669                 one element in detail
node rvp/pd.mjs click "Images"            click by name (by id when a name is not unique: click e432)
node rvp/pd.mjs hover "Save Image"        mouse on it: prints its tooltip. On a row: the tooltip of each button
node rvp/pd.mjs fill "search images" "hello"   type into a field
node rvp/pd.mjs press Enter               press a key
node rvp/pd.mjs shot e432 "what it shows" screenshot, element e432 outlined in red
node rvp/pd.mjs pass e432 "<claim>" "<what you saw that proves it>"
node rvp/pd.mjs fail e432 "<claim>" "<what you saw instead>"
node rvp/pd.mjs skip "<claim>" "<why it could not be checked>"
node rvp/pd.mjs eval e432 "el => el.title"   JavaScript on one element
```

## What the answers look like

```
You are on page /images. Tabs here: [Summary] (open), History.
- navigation: Dashboard, Containers, Pods, Images, Volumes, Networks, Secrets, Kubernetes, Extensions, Accounts, Settings
- heading "images" [id=e407]
- button "Pull" [id=e432]
- row "quay.io/podman/hello" [id=e669]: USED, podman, 2 years. Buttons: Run Image, Delete Image (disabled), kebab menu
```

- The first line says the page, the tabs with the open one, and the tooltip if one is shown.
  Tabs are buttons; only this line tells which tab is open.
- Use names. If several things have the name, the answer lists them with ids: use the id.
- After `click`, `fill` or `press` the answer is only what changed in the window.
- A row is one line: values, then buttons. Actions that are not there are in its `kebab menu`
  (click it) or on the details page (click the name of the item).
- Ids work only in these commands, never inside JavaScript: the page does not know them.
- Tooltips exist only under the mouse. `hover` answers
  `styled tooltip, shown above the button: "..."`, or says that the browser shows its own tooltip
  from the title (the old kind). For a tooltip that changes when the button is clicked: `hover`,
  then `click`, and read the line `Tooltip during the click`.
- You cannot see pictures: what you know comes from these answers.

## Steps

1. "What to verify" below **alone decides what you check**, usually one to three claims. The pull
   request text only explains them. Your plan, if you wrote one, is in `rvp/plan.md`.
2. One claim at a time: open the page, tab or dialog the claim names, and check the first line
   says it is the open one. Something similar elsewhere proves nothing.
3. Show it: `shot <id> "<what it shows>"` on the element that proves or disproves the claim.
4. Give the verdict at once with `pass`, `fail` or `skip` and the id of that element. Never return
   to a claim that has a verdict. Two failed attempts: `skip`, saying what you tried. After 25
   commands without a verdict, only a verdict is accepted.
5. When every claim has a verdict, write `rvp/notes.md` (three to ten lines) and stop.

## Rules

- Say only what you observed; the reason of a `pass` quotes what an answer printed.
- The app not doing what is claimed is a `fail`. A wrong `pass` is worse than a `skip`.
- In a claim, a reason or the notes, name things by their text, never by an id.
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
