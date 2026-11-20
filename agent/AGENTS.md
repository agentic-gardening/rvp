# Your task

Podman Desktop is built and **running right now**. Drive it with `node rvp/pd.mjs` and give a
verdict for each numbered claim of "What to verify". Only those claims; the pull request text
explains them.

## Commands

```
node rvp/pd.mjs look                      what can be used or read in the window
node rvp/pd.mjs look "hello"              the row or section that contains a text
node rvp/pd.mjs click "Images"            click by name (by id when a name is not unique: click e432)
node rvp/pd.mjs hover "Save Image"        mouse on it: prints its tooltip. On a row: the tooltip of each button
node rvp/pd.mjs fill "search images" "hello"   type into a field
node rvp/pd.mjs press Enter               press a key
node rvp/pd.mjs size                      screenshots at three window sizes; says what is cut off at each
node rvp/pd.mjs eval e432 "el => el.title"   JavaScript on one element
node rvp/pd.mjs extension-json "Kind"     the package.json of an extension (what it contributes)
node rvp/pd.mjs pass 1 e432 "what you saw"    claim 1 is true (e432: the element that shows it, for the screenshot)
node rvp/pd.mjs fail 1 e432 "what you saw instead"   claim 1 is false: the app does not do it
node rvp/pd.mjs skip 1 "why"                  claim 1 could not be checked
```

## Reading an answer

```
You are on page /images. Tabs here: [Summary] (open), History.
- navigation: Dashboard, Containers, Pods, Images, Volumes, Networks, Secrets, Kubernetes, Extensions, Accounts, Settings
- button "Pull" [id=e432]
- row "quay.io/podman/hello" [id=e669]: USED, podman, 2 years. Buttons: Run Image [id=e675], Delete Image [id=e681] (disabled), kebab menu [id=e688]
- checkbox "Quit the app when the close button is clicked" [off] [id=e206]
```

- First line: the page, the tabs with the open one, the tooltip if one is shown.
- `[id=e432]` is for click, hover and eval (never inside JavaScript). Ids die when the page
  changes: `look` again.
- A row is one line: values, buttons, open menu. The id of a row opens its details. Buttons of
  rows share their names: use their id. `look "<name>"` shows one row in full.
- `[on]` / `[off]` is a switch or a checkbox. A dropdown is a button named by its value.
- After click, fill or press you get only what changed.
- You cannot see pictures. The tool says what matters: tooltips, what is cut off,
  `Icon from an extension: <id> (drawn)`.

## Verdicts

- `pass`, `fail` or `skip` with the claim number, as soon as an answer prints the fact.
- The reason quotes that answer. Name things by their text, never by an id.
- The app does something else: `fail`. Two tries without luck: `skip`. A wrong pass is worse.
- The same number again replaces the verdict. No verdict after 40 commands or 30 minutes: closed.
- Every answer ends with the open claims. None left: write `rvp/notes.md` (3 to 10 lines), stop.

## Tips

- Be on the page, tab or dialog the claim names: the first line must say so.
- Tooltip: `hover` it. The answer says `styled tooltip, shown above the button: "..."` or that the
  browser shows its own from the title (the old kind). Wrong side: `fail`. Each hover takes the
  screenshot, no id needed. Changes on click: `hover`, `click`, read `Tooltip during the click`.
- Sizes or resolutions: `size`, then the verdict from what it printed. `size "name"` names the
  screenshots, `size 1024 768` is another size.
- A setting: click "Settings", its section, the checkbox once. `[on]`/`[off]` says the state.
- Need a container or an image: use `podman`, never the "Create" form, then `look` again.
  `podman run -d --name rvp-x --label <label>=x quay.io/podman/hello` gives one with a label.
- Never delete or change what "Already prepared for you" lists.
- Install an extension: click "Extensions", click "Catalog", fill "search extensions" "<name>",
  click its "Install ... Extension" button. Kind, Compose, Registries are bundled: nothing to install.
- What an extension adds: `extension-json "<name>"`, once per extension. `contributes.icons` are
  its icons; `contributes.views` says the list (`icons/containersList`: Containers,
  `icons/image`: Images) and the `when` condition, often a label. Make a container with that
  label, open the list, `look "rvp-x"`. The catalog proves nothing about icons.
- Extension from an image: click "Install custom...", fill "OCI Image", click "Install".
  From source: build it outside this repository, then `node rvp/pd.mjs restart <folder>`.
- An error, or lost: `look`. The same command failed twice: do something else.
- A text shown only for a moment and not seen: `skip`.
- macOS has no container engine: `skip` what needs one.

## Rules

- One short sentence before a command. Never set a timeout.
- Write files only in `rvp/`. No `git commit`, no `git push`, no GitHub calls.
