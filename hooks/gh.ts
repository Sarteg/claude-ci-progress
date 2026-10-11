// Helpers for talking to the GitHub API through `gh api -i`.
// No host imports here, so everything in this file is easy to test.

export type GhResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type CacheEntry = { etag: string; body: string }

export type ApiRun = {
  id: number
  name: string | null
  head_branch: string | null
  status: string
}

export type RunRow = {
  databaseId: number
  workflowName: string
  headBranch: string
  status: string
}

// Stop calling GitHub when this many calls are left, so the person's own `gh` use still works.
export const RESERVE = 100

// How long to wait when GitHub says "rate limit" but gives no reset time.
export const FALLBACK_PAUSE = 60_000

export const MAX_CACHE = 500

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// `gh api -i` prints a status line, the headers, a blank line, then the body.
export const parseGhResponse = (stdout: string): GhResponse | null => {
  const m = /^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n\r?\n([\s\S]*))?$/.exec(stdout)

  if (!m) {
    return null
  }

  const headers: Record<string, string> = {}

  for (const line of (m[2] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':')

    if (i > 0) {
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
    }
  }

  return { status: Number(m[1]), headers, body: m[3] ?? '' }
}

// When must we stop calling GitHub? Returns the time to resume (ms since epoch), or null to carry on.
// A 403 is only a rate limit when GitHub says so: listing runners also gives a plain 403 without admin rights.
export const pauseUntil = (res: GhResponse | null, stderr: string, now: number): number | null => {
  if (res === null) {
    return /rate limit/i.test(stderr) ? now + FALLBACK_PAUSE : null
  }

  const remaining = Number(res.headers['x-ratelimit-remaining'] ?? NaN)
  const reset = Number(res.headers['x-ratelimit-reset'] ?? NaN) * 1000
  const retryAfter = Number(res.headers['retry-after'] ?? NaN)

  if (res.status === 403 || res.status === 429) {
    if (Number.isFinite(retryAfter)) {
      return now + retryAfter * 1000
    }

    if (remaining === 0 && Number.isFinite(reset)) {
      return Math.max(reset, now + 5_000)
    }

    return /rate limit/i.test(res.body) ? now + FALLBACK_PAUSE : null
  }

  if (Number.isFinite(remaining) && remaining <= RESERVE && Number.isFinite(reset)) {
    return Math.max(reset, now + 5_000)
  }

  return null
}

export const pauseMessage = (until: number) => {
  const t = new Date(until)
  const hh = String(t.getHours()).padStart(2, '0')
  const mm = String(t.getMinutes()).padStart(2, '0')

  return `Paused until ${hh}:${mm} to stay within GitHub's API rate limit. It resumes by itself.`
}

// Send the saved ETag so GitHub can answer `304 Not Modified`. A 304 does not count against the rate limit.
export const buildArgs = (endpoint: string, etag?: string) => [
  'gh',
  'api',
  '-i',
  ...(etag ? ['-H', `If-None-Match: ${etag}`] : []),
  endpoint,
]

// Newest entry goes last, and the oldest is dropped once the cache is full.
export const remember = (cache: Map<string, CacheEntry>, key: string, entry: CacheEntry) => {
  cache.delete(key)
  cache.set(key, entry)

  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value

    if (oldest === undefined) {
      break
    }

    cache.delete(oldest)
  }
}

export const runsEndpoint = (status: string) =>
  `repos/{owner}/{repo}/actions/runs?status=${status}&per_page=100&exclude_pull_requests=true`

export const runsFrom = (body: string): RunRow[] => {
  const runs = (parseJson(body) as { workflow_runs?: ApiRun[] } | null)?.workflow_runs ?? []

  return runs.map(r => ({
    databaseId: r.id,
    workflowName: r.name ?? '',
    headBranch: r.head_branch ?? '',
    status: r.status,
  }))
}
