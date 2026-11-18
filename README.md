# rvp

Verify a Podman Desktop pull request on a GitHub-hosted runner with a local model.

```sh
gh workflow run verify.yml \
  -f pr=1234 \
  -f runner=linux \
  -f instruction="verify that I can install 3 extensions"
```

`runner` is `linux`, `windows` or `macos`.

Writing the instruction: name the place the way the app does ("the Local extensions tab of the
Extensions page") and state one fact that can be checked per sentence. A small model does what the
sentence says, not what you meant.

## What happens

1. **agent job** (no secret, read-only token)
   - installs Ollama, the model and opencode (pinned, cached);
   - fetches the pull request, `pnpm install`, `pnpm build`;
   - starts the built app and keeps it running;
   - the model reads the instruction and the PR description, then drives the app with a small
     command (`node rvp/pd.mjs look | click | fill | eval | shot`), takes screenshots of the elements
     that prove or disprove each claim, and records a verdict per claim
     (`pass | fail | skip`);
   - the app is closed and the result folder is uploaded as the `rvp-result` artifact.
2. **comment job** (holds the tokens, runs no PR code)
   - checks the folder, publishes the screenshots, comments on the pull request.

The agent never commits or comments.

## Result folder

```
result.json     outcome (pass | fail | mixed | no_result) and one entry per claim
media/          screenshots (.png) with the evidence outlined in red, one video per app session (.webm)
                the video skips the time where nothing moves (a still window lasts 1 second at most)
traces/         Playwright traces with the real timing (npx playwright show-trace <file>)
TASK.md         the task given to the model
actions.log     every command the model ran on the app, with what the app answered
steps.log       the same actions in plain words, with names instead of ids (shown in the comment)
progress.log    one line per command (what the run page shows live)
build.log       pnpm install and build output (build-base.log for the base), ollama-pull.log
notes.md        what the model says it did
agent.log       the model's session
```

The verdicts are the model's own judgement. The screenshot taken at the moment of each verdict, the
video and `actions.log` are there so a person can check them.

## Screenshots

- Each screenshot is taken in light and in dark theme (`themes: false` to turn that off).
- Before/after: by default (`before-after: auto`) when the pull request changes `packages/renderer`
  or `packages/ui`; `true` or `false` forces it. The commit the pull request starts from is built too, and a second app
  runs next to the first. It is brought to the same page after every action and each screenshot is
  taken on both, shown as a Before / After table. Both apps use the same container engine, so the
  second app never repeats a click on a button whose name says it changes something (start, delete,
  create, pull, install, ...); that is a guess from the name. Extensions and settings are not
  shared between the two apps.
- The comment job publishes 40 images per run at most (4 files per screenshot with both options on).

## Setup

- Secret `RVP_COMMENT_TOKEN`: a token allowed to comment on pull requests of the target repository.
- The repository must be public: screenshots are stored on its `media` branch and linked from the comment.

## Triggering it with a pull request comment

`examples/pr-comment.yml` starts a run when someone who can push to the repository comments
`/rvp <what to check>` on a pull request (`/rvp macos model=qwen3.5:4b <what to check>` to pick the
runner and the model), and
posts the result on that pull request. To use it:

1. Copy it to `.github/workflows/rvp.yml` on the default branch of the repository to verify, and
   replace `<commit-sha>` with the rvp commit to use.
2. If this repository (rvp) is private, allow the other one to use it: Settings → Actions →
   General → Access → accessible from repositories in the organization.

No extra token: the job's own token comments on the pull request, and the screenshots go to a
`media` branch of that repository, which must be public for them to display.

## Using the actions directly

```yaml
- uses: agentic-gardening/rvp/agent@main     # on the runner of your choice
  with: { pr: 1234, instruction: "..." }
- uses: agentic-gardening/rvp/comment@main   # in another job, after downloading the artifact
  with: { dir: result, repo: podman-desktop/podman-desktop, pr: 1234, token: "${{ secrets.X }}" }
```

Both run prebuilt files from their `dist/` folder: nothing is installed for rvp itself.

## Limits

- The model runs on CPU. Expect slow runs, and `no_result` when it gets lost.
  An 8B model with a 32k context needs about 10 GB of memory; macOS runners have about 7 GB:
  pass a smaller `model` there or use a larger runner.
- A verdict is what a small model concluded from the text of the window. It cannot see images.
  The comment shows the action log and screenshots for that reason.
- No container engine on macOS runners: only UI checks there.
- Three operating systems times (Ollama + model) is more than the 10 GB cache of a repository:
  the least recently used one is evicted and downloaded again.

## Development

```sh
bun run test     # src/result.test.ts
bun run build    # writes agent/dist and comment/dist; commit them
node comment/dist/index.mjs --dry-run <result folder>   # print the comment, no network
```

To run the whole agent action on your machine (macOS or Linux; needs `gh` logged in, Node 24, pnpm):

```sh
bun run local 1234 "verify that I can install 3 extensions" [model] [--before-after | --no-before-after] [--no-themes] [--gist]
```

- The comment is written to `.local/rvp-out/comment.md`. It is never posted on the pull request.
- `--gist` also publishes it with its screenshots as a secret gist on your own account, to see it
  rendered. Secret means unlisted: anyone with the link can open it. `gh gist delete <id>` removes it.

It runs the `run:` steps of `agent/action.yml` in `.local/`, reuses the downloads and the build on
the next run for the same PR, and prints the comment without posting it. Nothing is written to GitHub.
If an Ollama is already listening on port 11434, that one is used (with its own model store) instead of the pinned one.

To try the session tool alone, in a built Podman Desktop checkout:

```sh
cp -R <rvp>/agent/kit rvp
node rvp/pd.mjs serve &        # prints "ready" when the app is up
node rvp/pd.mjs look
node rvp/pd.mjs stop
```
