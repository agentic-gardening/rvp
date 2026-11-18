# Your task

You verify a pull request of Podman Desktop (a desktop app). The pull request is already built and
**the app is running right now**. You operate it with one command, `node rvp/pd.mjs`, look at what
it shows, and record for each claim whether it is true.

## Commands

```
node rvp/pd.mjs look                      print what can be used or read in the window
node rvp/pd.mjs look "hello"              print the row or the section that contains a text
node rvp/pd.mjs look e538                 print one element and everything inside it
node rvp/pd.mjs click "Images"            click something, by its name
node rvp/pd.mjs click e114                click something, by its id (when several things have the same name)
node rvp/pd.mjs hover "Save Image"        put the mouse on it: prints its tooltip
node rvp/pd.mjs hover e538                on a row: prints the tooltip of every button of that row
node rvp/pd.mjs fill "search images" "hello"   type into a field
node rvp/pd.mjs press Enter               press a key
node rvp/pd.mjs shot e461 "the Local extensions tab"   save a screenshot with element e461 outlined in red
node rvp/pd.mjs pass e461 "<claim>" "<what you saw that proves it>"
node rvp/pd.mjs fail e461 "<claim>" "<what you saw instead>"
node rvp/pd.mjs skip "<claim>" "<why it could not be checked>"
node rvp/pd.mjs eval "document.title"     run JavaScript in the page and print the value
node rvp/pd.mjs eval e114 "el => el.getAttribute('aria-describedby')"   run a function on one element
node rvp/pd.mjs restart /path/to/extension   only for an extension you built from source: relaunch the app with it
```

## Reading the window

The first line of every answer says where you are: the page, the tabs of that page with the open
one, and the tooltip if one is shown. Then come lines `role "name" [id=...]`, sometimes with a text:

```
You are on page /images.
- navigation: Dashboard, Containers, Pods, Images, Volumes, Networks, Secrets, Kubernetes, Extensions, Accounts, Settings
- region "images" [id=e404]:
  - heading "images" [level=1] [id=e407]
  - button "Pull" [id=e432]
  - textbox "search images" [id=e452]
  - table "image" [id=e457]:
    - columns: Status, Name, Environment, Age, Size, Arch, Actions
    - row "quay.io/podman/hello" [id=e669]: USED, podman, 2 years, 579.59 kB, arm64. Buttons: Run Image, Delete Image (disabled), kebab menu
```

- A `row` is one line: its values, then its buttons. `look e669` shows the row in detail, with the
  id of each button.
- The status bar at the bottom of the window is left out: `look "Status Bar"` shows it.
- Use the name: `node rvp/pd.mjs click "Local extensions"`. When several things have that name the
  answer lists them with their ids: then use the id, copied exactly (`e114` or `f1e114`).
- After `click`, `fill` or `press` the answer shows only what changed: the lines that appeared,
  under what they are in, and the first lines that went away. "Nothing changed in the window"
  means your action had no visible effect.
- Tabs are buttons. Only the first line tells which tab is open, for example
  `Tabs here: [Installed] (open), Catalog, Local extensions.` To see the Local extensions tab,
  click it and check that the first line now says `[Local extensions] (open)`.
- Actions that are not in the row are in its `kebab menu` button (click it:
  the menu items appear) or on the details page of the item (click its name).
- Ids exist only for these commands. The page does not know them: `document.querySelector('#e114')`
  finds nothing. To learn about an element use `look e114`, `hover e114` or `eval e114 "el => ..."`.
- You cannot see pictures. Everything you know about the app comes from these commands.
- If something is not there yet (a list still loading), `look "<text>"` again.

Tooltips: a tooltip exists only while the mouse is on the element. `hover` prints it, and where it is:

```
hovering button "Update Image" (disabled)
  styled tooltip, shown above the button: "Cannot update an image used by a container"
```

- "The browser shows its own tooltip from the title" is the old kind of tooltip (the `title` of the
  element). It works; it is just not the app's styled tooltip.
- While a styled tooltip is shown, `shot <id> "..."` puts it in the screenshot.
- A tooltip whose text changes when the button is clicked: `hover` it, then `click` it. The answer
  of the click has a line `Tooltip during the click: "..." → "..."` when the text changed.

The main navigation links are: Dashboard, Containers, Pods, Images, Volumes, Networks, Secrets,
Kubernetes, Extensions, Accounts, Settings.

## Steps

1. Read "What to verify" at the end of this file. **It alone decides what you check.** The pull
   request text below it explains the change; check a claim from that text only if "What to
   verify" asks for it, or asks to verify the whole pull request. Usually this is one to three
   claims. If you wrote a plan, it is in `rvp/plan.md`.
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
5. Work on one claim at a time. After 25 commands without a verdict, only a verdict is accepted. Give its verdict as soon as you have seen what decides it, before
   you start the next claim, and never go back to a claim that has a verdict. If two different
   attempts did not let you see it, record `skip` with what you tried and go on.
6. When every claim has a verdict, write `rvp/notes.md` (three to ten lines: what you checked and
   what you found) and stop.

## Rules

- Ids such as `e114` are only for commands. In a claim, a reason or the notes, never write an id:
  name things by their text, like a person would ("the Local extensions tab", "the search field").
- Say only what you observed. The reason of a `pass` must quote what `look` or `eval` printed.
- If the app does not do what the pull request says, that is a `fail`. Never record a `pass` to be nice.
- If you tried and cannot tell, use `skip`. A wrong `pass` is worse than a `skip`.
- Write files only inside `rvp/`. Never change another file of the repository.
- No `git commit`, no `git push`, no GitHub calls. Someone else publishes your result.

## Preparing what a claim needs

Some claims need something to exist first: an image, a container using an image, a volume. You
may create it with `podman` commands, then `look` again (the app shows it after a few seconds):

```
podman pull quay.io/podman/hello                      an image
podman run -d --name rvp-test quay.io/podman/hello    a container, so that image is "used"
podman build -t rvp-test-image <folder>               an image from a Containerfile you wrote outside this repository
```

Say in the reason of your verdict what you created.

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
