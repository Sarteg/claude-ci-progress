# claude-ci-progress

A [Claude Code](https://claude.com/claude-code) mod that adds a live **CI progress** tab for GitHub Actions. It shows one progress bar for each runner, so you can watch your CI without leaving the terminal.

```
Runners 3 · Running 2 · Queued 1 · Remaining 3

● my-runner-1
  ████████████░░░░░░░░ 13/17 steps
  [ ▸ 13/17 Backend-Tests ]

● my-runner-2
  ██████░░░░░░░░░░░░░░ 6/11 steps
  [ ▾ 6/11 Frontend-Unit-Tests ]
    Frontend-Unit-Tests · main
    ✓ Set up job
    ✓ Check out main
    ▸ Run unit tests
    · Post Check out main

● my-runner-3
  waiting for jobs

Queued (waiting for a runner): 1
  · queued Lint
```

## Features

- **One block per runner**, with a progress bar and a `done/total steps` count.
- **Summary header**: runners, running jobs, queued jobs, remaining jobs.
- **Expandable jobs**: click a job line to list its steps (`✓` done, `▸` running, `·` waiting, `✗` failed).
- **Status dots**: pulsing yellow = running a job, green = online and waiting for jobs, grey = offline.
- **Queue block**: jobs that no runner has picked up yet.
- Works in a terminal and in the desktop app. It shows as a tab beside the other panes.

## Requirements

- [Claude Code](https://claude.com/claude-code) with plugin support.
- [GitHub CLI](https://cli.github.com/) (`gh`), signed in:
  ```bash
  gh auth login
  ```
- A git repo with a GitHub remote and GitHub Actions.
- Repo **admin** rights, to list runners (the online and offline dots, and idle runners). Without them the bars and the queue still work.

## Install

At the Claude Code prompt, type:

```
/plugin install ci-progress --marketplace Sarteg/claude-ci-progress
```

Then:

1. Press `y` to add the marketplace.
2. Pick a scope. Choose **user** to have it in every session.
3. Type `/ci-progress` to open the tab.

If a session was already open, type `/reload-plugins` first.

To try it without installing, clone the repo and start Claude with the folder:

```bash
git clone https://github.com/Sarteg/claude-ci-progress.git
claude --plugin-dir ./claude-ci-progress
```

## Update

```bash
claude plugin update ci-progress
```

Then type `/reload-plugins` in a running session.

## Use

- The tab opens by itself when the terminal is wide enough (144 columns or more). In a narrower terminal, type `/ci-progress` to open it.
- The tab refreshes every 10 seconds while a job runs, every 30 seconds when idle, and right after each Claude turn.
- `/ci-progress` also prints what the mod sees: the folder, the repos found, the last result, and any `gh` error.

## Options

| Option | What it does |
| --- | --- |
| `folders` | Optional. Comma-separated full paths of git repos to watch. Empty means: the session folder, or the repos found up to 3 levels below it. |

Open the plugin screen with `/plugin` to change an option, then type `/reload-plugins`.

## How it works

The mod calls `gh` and reads three things for each repo:

1. `gh run list`, for the runs that are not finished.
2. `gh api repos/{owner}/{repo}/actions/runs/<id>/jobs`, for the jobs and their steps.
3. `gh api repos/{owner}/{repo}/actions/runners`, for the runner names and states.

GitHub does not report a percent for a run. The bar counts finished steps out of all steps, so it can move at an uneven speed when some steps take much longer than others.

A job belongs to the runner that reports it. A job that no runner has taken yet goes in the queue block.

## Troubleshooting

| You see | Do this |
| --- | --- |
| `No git repo found in ...` | Start Claude in a repo, or set the `folders` option. |
| An error from `gh` | Run `gh auth status`. Sign in with `gh auth login`. |
| No dots, no idle runners | `gh` has no admin rights on the repo. The bars still work. |
| The tab does not show | Type `/ci-progress`. Widen the terminal. |
| Old behaviour after an update | Type `/reload-plugins`, or start a new session. |

## Develop

```bash
claude plugin validate .
claude plugin test .
```

The code is in `hooks/register.tsx`. The tests are in `hooks/bar.test.ts`.

## Licence

[MIT](LICENSE)
