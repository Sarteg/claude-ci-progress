import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, Lane } from '../types'
import {
  buildArgs,
  parseGhResponse,
  parseJson as parse,
  pauseMessage,
  pauseUntil,
  remember,
  runsEndpoint,
  runsFrom,
} from './gh'
import type { CacheEntry } from './gh'

const PANE = 'ci-progress'
const lanes = atom({ plugin: 'ci-progress', key: 'lanes' } as const, [])
const error = atom({ plugin: 'ci-progress', key: 'error' } as const, null)
const opened = atom({ plugin: 'ci-progress', key: 'open' } as const, [])
const pulse = atom({ plugin: 'ci-progress', key: 'pulse' } as const, false)

const BUSY_EVERY = 10_000
const IDLE_EVERY = 30_000
const RESCAN_EVERY = 60_000
// A poll forced by the end of a Claude turn still waits at least this long after the last one.
const MIN_GAP = 5_000
const MAX_REPOS = 6

export const bar = (part: number, width: number) => {
  const full = Math.round(Math.max(0, Math.min(1, part)) * width)

  return '█'.repeat(full) + '░'.repeat(width - full)
}

export const QUEUE = 'queued'

// Every run status that is not finished (`gh run list --status` takes one value per call).
export const ACTIVE_STATUSES = ['in_progress', 'queued', 'waiting', 'pending', 'requested'] as const

// One row per run id: the same run can come back from two status calls if it changes state between them.
export const uniqueRuns = <T extends { databaseId: number }>(lists: T[][]): T[] => [
  ...new Map(lists.flat().map(r => [r.databaseId, r] as const)).values(),
]

export const laneOf = (status: string, runnerName: string | null) =>
  status === 'queued' || !runnerName ? QUEUE : runnerName

export const summarize = (list: Lane[]) => {
  const jobs = list.flatMap(l => l.jobs)
  const running = jobs.filter(j => j.status === 'in_progress').length
  const queued = jobs.filter(j => j.status === 'queued').length

  return {
    runners: list.filter(l => l.key !== QUEUE).length,
    running,
    queued,
    remaining: running + queued,
  }
}

export const dotState = (lane: Lane): 'running' | 'waiting' | 'offline' | 'none' => {
  if (lane.key === QUEUE) {
    return 'none'
  }

  if (lane.jobs.some(j => j.status === 'in_progress')) {
    return 'running'
  }

  return lane.online === false ? 'offline' : 'waiting'
}

export const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text

export const laneSteps = (jobs: Job[]) =>
  jobs.reduce(
    (sum, j) => {
      if (j.total > 0) {
        return { done: sum.done + j.done, total: sum.total + j.total }
      }

      return { done: sum.done + (j.status === 'completed' ? 1 : 0), total: sum.total + 1 }
    },
    { done: 0, total: 0 },
  )

export const laneProgress = (jobs: Job[]) => {
  const { done, total } = laneSteps(jobs)

  return total === 0 ? 0 : done / total
}

export const repoDirsFrom = (findOut: string) => {
  const dirs = findOut
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.endsWith('/.git') && !l.includes('/worktrees/') && !l.includes('/node_modules/'))
    .map(l => l.slice(0, -'/.git'.length))

  return [...new Set(dirs)].sort().slice(0, MAX_REPOS)
}

type ApiJob = {
  name: string
  status: string
  conclusion: string | null
  runner_name: string | null
  labels: string[]
  steps?: Array<{ name: string; status: string; conclusion: string | null }>
}

type ApiRunner = {
  name: string
  status: string
  labels: Array<{ name: string }>
}

let cwd: string | undefined
let folders: string[] = []
let repoDirs: string[] = []
let lastScan = 0
let isBusy = false
let hasRunning = false
let lastPoll = 0
let polls = 0
let note = 'not polled yet'
let forceNext = false
// The rate limit belongs to the token, so one pause covers every repo.
let pausedUntil = 0
const etags = new Map<string, CacheEntry>()
// Repos where listing runners is not allowed (needs admin rights): do not ask again.
const noRunnerAccess = new Set<string>()

type ApiResult = { ok: true; body: string } | { ok: false; error: string; status: number; limited: boolean }

// One GitHub API call. It sends the saved ETag, so an unchanged page comes back as `304 Not Modified`,
// which does not count against the hourly rate limit. It also reads the rate-limit headers and
// sets `pausedUntil` when the limit is hit or nearly used up.
const api = async ($: EngineInterface, dir: string, endpoint: string): Promise<ApiResult> => {
  const key = `${dir}\n${endpoint}`
  const hit = etags.get(key)
  const r = await $.process.run(buildArgs(endpoint, hit?.etag), { cwd: dir, timeoutMs: 20_000 })
  const res = parseGhResponse(r.stdout)
  const until = pauseUntil(res, r.stderr, await $.clock.now())

  if (until !== null) {
    pausedUntil = Math.max(pausedUntil, until)
  }

  // Some `gh` versions exit non-zero on a 304, so go by the status line and not the exit code.
  if (res?.status === 304 && hit) {
    remember(etags, key, hit)

    return { ok: true, body: hit.body }
  }

  if (res !== null && res.status >= 200 && res.status < 300) {
    if (res.headers.etag) {
      remember(etags, key, { etag: res.headers.etag, body: res.body })
    }

    return { ok: true, body: res.body }
  }

  const message = (parse(res?.body ?? '') as { message?: string } | null)?.message

  return {
    ok: false,
    error: message ?? (r.stderr.trim().split('\n')[0] || 'gh failed'),
    status: res?.status ?? 0,
    limited: until !== null,
  }
}

const resolveRepos = async ($: EngineInterface, now: number) => {
  if (folders.length > 0) {
    repoDirs = folders

    return
  }

  if (repoDirs.length > 0 || now - lastScan < RESCAN_EVERY) {
    return
  }

  lastScan = now

  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10_000 })

  if (top.exitCode === 0 && top.stdout.trim() !== '') {
    repoDirs = [top.stdout.trim()]

    return
  }

  const found = await $.process.run(
    [
      'find',
      cwd ?? '.',
      '-maxdepth',
      '3',
      '(',
      '-name',
      'node_modules',
      '-o',
      '-name',
      'worktrees',
      ')',
      '-prune',
      '-o',
      '-name',
      '.git',
      '-print',
    ],
    { cwd, timeoutMs: 20_000 },
  )

  repoDirs = repoDirsFrom(found.stdout)
}

const collect = async (
  $: EngineInterface,
  dir: string,
  label: string | null,
): Promise<{ lanes: Lane[]; failed: string | null; listed: number; active: number }> => {
  // Ask for each active status, not the newest N runs: one push can start 30+ runs, which pushed
  // long-running jobs off a `--limit 20` list and showed busy runners as idle.
  // Each call is conditional (see `api`), so a list that has not changed costs nothing.
  const lists = await Promise.all(ACTIVE_STATUSES.map(s => api($, dir, runsEndpoint(s))))
  const bad = lists.find(l => !l.ok)

  if (bad && !bad.ok) {
    return {
      lanes: [],
      failed: `${dir}: ${bad.error}`,
      listed: 0,
      active: 0,
    }
  }

  const rows = uniqueRuns(lists.map(l => (l.ok ? runsFrom(l.body) : [])))
  const active = rows.filter(r => r.status !== 'completed')
  const found: Record<string, Lane> = {}

  const runners = noRunnerAccess.has(dir)
    ? null
    : await api($, dir, 'repos/{owner}/{repo}/actions/runners?per_page=100')

  if (runners?.ok) {
    const all = (parse(runners.body) as { runners?: ApiRunner[] } | null)?.runners ?? []

    for (const r of all) {
      found[r.name] = { key: r.name, online: r.status === 'online', jobs: [] }
    }
  } else if (runners && !runners.limited && (runners.status === 403 || runners.status === 404)) {
    // No admin rights (or GitHub-hosted runners only): the bars and the queue still work without it.
    noRunnerAccess.add(dir)
  }

  const perRun = await Promise.all(
    active.map(async r => {
      const res = await api($, dir, `repos/{owner}/{repo}/actions/runs/${r.databaseId}/jobs?per_page=100`)
      const jobs = (res.ok ? (parse(res.body) as { jobs?: ApiJob[] } | null)?.jobs : undefined) ?? []

      return jobs.map(j => {
        const steps = j.steps ?? []
        const status: Job['status'] =
          j.status === 'completed' ? 'completed' : j.status === 'in_progress' ? 'in_progress' : 'queued'

        return {
          key: laneOf(j.status, j.runner_name),
          job: {
            name: j.name,
            run: label === null ? r.workflowName : `${label}/${r.workflowName}`,
            branch: r.headBranch,
            status,
            conclusion: j.conclusion,
            done: steps.filter(s => s.status === 'completed').length,
            total: steps.length,
            steps: steps.map(st => ({ name: st.name, status: st.status, conclusion: st.conclusion })),
          } as Job,
        }
      })
    }),
  )

  for (const { key, job } of perRun.flat()) {
    const lane = found[key] ?? { key, online: null, jobs: [] }
    found[key] = { ...lane, jobs: [...lane.jobs, job] }
  }

  return { lanes: Object.values(found), failed: null, listed: rows.length, active: active.length }
}

const poll = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const wait = forceNext ? MIN_GAP : isBusy ? BUSY_EVERY : IDLE_EVERY

  if (now - lastPoll < wait - 500) {
    return
  }

  forceNext = false
  lastPoll = now

  // Rate-limited: make no GitHub calls until the limit resets.
  if (now < pausedUntil) {
    note = `paused until ${new Date(pausedUntil).toISOString()}`
    await update($, error, () => pauseMessage(pausedUntil))
    await update($, lanes, () => [])

    return
  }

  polls += 1

  await resolveRepos($, now)

  if (repoDirs.length === 0) {
    note = `no git repo found in ${cwd}`
    await update($, error, () => `No git repo found in ${cwd}. Set the "folders" option of ci-progress.`)
    await update($, lanes, () => [])
    isBusy = false
    hasRunning = false

    return
  }

  const base = (d: string) => d.split('/').filter(Boolean).pop() ?? d
  const results = await Promise.all(
    repoDirs.map(d => collect($, d, repoDirs.length > 1 ? base(d) : null)),
  )
  const failed = results.filter(r => r.failed !== null)
  const merged: Record<string, Lane> = {}

  for (const lane of results.flatMap(r => r.lanes)) {
    const old = merged[lane.key]
    merged[lane.key] = old
      ? {
          key: lane.key,
          online: old.online === true || lane.online === true ? true : (old.online ?? lane.online),
          jobs: [...old.jobs, ...lane.jobs],
        }
      : lane
  }

  const next = Object.values(merged).sort(
    (a, b) =>
      Number(a.key === QUEUE) - Number(b.key === QUEUE) ||
      b.jobs.length - a.jobs.length ||
      a.key.localeCompare(b.key),
  )

  isBusy = next.some(l => l.jobs.length > 0)
  hasRunning = next.some(l => dotState(l) === 'running')
  note = `repos: ${repoDirs.join(', ')}; ${results.reduce((n, r) => n + r.active, 0)} active runs; ${failed.length} failed`

  if (failed.length === results.length) {
    await update($, error, () => (pausedUntil > now ? pauseMessage(pausedUntil) : (failed[0]?.failed ?? 'gh failed')))
    await update($, lanes, () => [])

    return
  }

  await update($, error, () => null)
  await update($, lanes, () => next)
}

const flip = async ($: EngineInterface) => {
  if (hasRunning) {
    await update($, pulse, v => !v)
  }
}

export const register: Register = (on, options) => {
  folders = String(options.folders ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'ci-progress',
      description: 'Open the CI progress pane',
    })
    void $.ui.open({ id: PANE, title: 'CI progress' })
    $.clock.every(2_000, () => {
      void poll($).catch(() => {})
    })
    $.clock.every(700, () => {
      void flip($).catch(() => {})
    })

    return next(e)
  })

  on('command.run', { command: 'ci-progress' }, async $ => {
    await $.ui.open({ id: PANE, title: 'CI progress' })
    const list = await read($, lanes)

    return {
      text: [
        'ci-progress: pane opened',
        `folder: ${cwd}`,
        `polls: ${polls}`,
        `last: ${note}`,
        ...list.map(l => `${l.key}: ${l.jobs.length} jobs`),
      ].join('\n'),
    }
  })

  on('turn.complete', async ($, e, next) => {
    // Refresh soon after a turn, but not more than once every MIN_GAP: agent teams end turns often.
    forceNext = true
    void poll($).catch(() => {})

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, lanes)
    const err = await read($, error)
    const open = await read($, opened)
    const beat = await read($, pulse)
    const cols = Math.max(20, e.props.bodyColumns)
    const total = summarize(list)
    const width = Math.max(8, Math.min(30, cols - 14))

    if (err !== null) {
      return <Text dimColor>CI: {err}</Text>
    }

    if (list.length === 0) {
      return <Text dimColor>No runners or CI jobs found.</Text>
    }

    return (
      <Box flexDirection="column">
        <Text> </Text>
        <Text> </Text>
        <Box marginBottom={1}>
          <Text bold>
            Runners <Text color="green">{String(total.runners)}</Text>
            {' · '}Running <Text color="yellow">{String(total.running)}</Text>
            {' · '}Queued <Text color="cyan">{String(total.queued)}</Text>
            {' · '}Remaining <Text color="magenta">{String(total.remaining)}</Text>
          </Text>
        </Box>
        {list.map(lane => {
          const isQueue = lane.key === QUEUE
          const state = dotState(lane)

          return (
            <Box key={lane.key} flexDirection="column" marginBottom={1}>
              <Text bold>
                {state === 'running' ? (
                  <Text color="yellow" dimColor={!beat}>● </Text>
                ) : state === 'waiting' ? (
                  <Text color="green">● </Text>
                ) : state === 'offline' ? (
                  <Text dimColor>● </Text>
                ) : (
                  <Text> </Text>
                )}
                {isQueue ? `Queued (waiting for a runner): ${lane.jobs.length}` : lane.key}
              </Text>
              {lane.jobs.length === 0 ? (
                <Text dimColor>{state === 'offline' ? '  offline' : '  waiting for jobs'}</Text>
              ) : (
                <Box flexDirection="column">
                  {!isQueue && (
                    <Text color="yellow">
                      {'  '}
                      {bar(laneProgress(lane.jobs), width)} {laneSteps(lane.jobs).done}/{laneSteps(lane.jobs).total} steps
                    </Text>
                  )}
                  {lane.jobs.map((j, i) => {
                    const id = `${j.run}|${j.name}`
                    const isOpen = open.includes(id)
                    const hasSteps = (j.steps ?? []).length > 0
                    const tag =
                      j.status === 'queued'
                        ? '· queued'
                        : j.status === 'completed'
                          ? j.conclusion === 'success'
                            ? '✓ done'
                            : `✗ ${j.conclusion ?? 'done'}`
                          : `${j.done}/${j.total}`
                    const title = clip(`${tag} ${j.name}`, cols - 10)

                    return (
                      <Box key={`${i}`} flexDirection="column">
                        {hasSteps ? (
                          <Box paddingLeft={2}>
                            <Button
                              key={`b${i}`}
                              label={`${isOpen ? '▾' : '▸'} ${title}`}
                              onPress={() =>
                                update($, opened, list =>
                                  list.includes(id) ? list.filter(x => x !== id) : [...list, id],
                                )
                              }
                            />
                          </Box>
                        ) : (
                          <Text dimColor>{`  ${title}`}</Text>
                        )}
                        {isOpen && <Text dimColor>{clip(`    ${j.run} · ${j.branch}`, cols - 1)}</Text>}
                        {isOpen &&
                          (j.steps ?? []).map((st, n) => (
                            <Text key={`s${i}-${n}`} dimColor={st.status === 'pending' || st.status === 'queued'}>
                              {clip(
                                `    ${
                                  st.status === 'completed'
                                    ? st.conclusion === 'success' || st.conclusion === 'skipped'
                                      ? '✓'
                                      : '✗'
                                    : st.status === 'in_progress'
                                      ? '▸'
                                      : '·'
                                } ${st.name}`,
                                cols - 1,
                              )}
                            </Text>
                          ))}
                      </Box>
                    )
                  })}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
