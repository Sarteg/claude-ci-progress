import { test, expect } from 'claude-code/testing'

import {
  FALLBACK_PAUSE,
  MAX_CACHE,
  buildArgs,
  parseGhResponse,
  pauseMessage,
  pauseUntil,
  remember,
  runsEndpoint,
  runsFrom,
} from './gh'
import type { CacheEntry, GhResponse } from './gh'

const NOW = 1_800_000_000_000

const res = (status: number, headers: Record<string, string> = {}, body = ''): GhResponse => ({
  status,
  headers,
  body,
})

test('parses status, headers and body from gh api -i', () => {
  const out = 'HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nX-Ratelimit-Remaining: 4990\r\n\r\n{"workflow_runs":[]}'
  const r = parseGhResponse(out)
  expect(r?.status).toBe(200)
  expect(r?.headers.etag).toBe('W/"abc"')
  expect(r?.headers['x-ratelimit-remaining']).toBe('4990')
  expect(r?.body).toBe('{"workflow_runs":[]}')
})

test('parses a 304 that has no body', () => {
  const r = parseGhResponse('HTTP/2.0 304 Not Modified\r\nEtag: "x"\r\n\r\n')
  expect(r?.status).toBe(304)
  expect(r?.headers.etag).toBe('"x"')
  expect(r?.body).toBe('')
})

test('parses a response with LF line endings and no blank line', () => {
  const r = parseGhResponse('HTTP/1.1 304 Not Modified\nEtag: "y"')
  expect(r?.status).toBe(304)
  expect(r?.headers.etag).toBe('"y"')
})

test('output that is not an HTTP response gives null', () => {
  expect(parseGhResponse('gh: command not found')).toBeNull()
  expect(parseGhResponse('')).toBeNull()
})

test('a 403 with no calls left pauses until the reset time', () => {
  const reset = NOW / 1000 + 1800
  const r = res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
  expect(pauseUntil(r, '', NOW)).toBe(reset * 1000)
})

test('Retry-After wins on a secondary limit', () => {
  const r = res(403, { 'retry-after': '30', 'x-ratelimit-remaining': '4000' })
  expect(pauseUntil(r, '', NOW)).toBe(NOW + 30_000)
})

test('a 403 that says rate limit but has no headers pauses for a minute', () => {
  const r = res(403, {}, '{"message":"API rate limit exceeded for user ID 1"}')
  expect(pauseUntil(r, '', NOW)).toBe(NOW + FALLBACK_PAUSE)
})

test('a plain permission 403 is not a rate limit', () => {
  const r = res(403, { 'x-ratelimit-remaining': '4000' }, '{"message":"Resource not accessible by integration"}')
  expect(pauseUntil(r, '', NOW)).toBeNull()
})

test('pauses early when only the reserve is left, and not before', () => {
  const reset = String(NOW / 1000 + 600)
  expect(pauseUntil(res(200, { 'x-ratelimit-remaining': '100', 'x-ratelimit-reset': reset }), '', NOW)).toBe(
    (NOW / 1000 + 600) * 1000,
  )
  expect(pauseUntil(res(200, { 'x-ratelimit-remaining': '101', 'x-ratelimit-reset': reset }), '', NOW)).toBeNull()
  expect(pauseUntil(res(304, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': reset }), '', NOW)).toBeNull()
})

test('a reset time in the past still waits a few seconds', () => {
  const r = res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 - 10) })
  expect(pauseUntil(r, '', NOW)).toBe(NOW + 5_000)
})

test('no response: stderr that mentions the rate limit pauses, other errors do not', () => {
  expect(pauseUntil(null, 'gh: API rate limit exceeded', NOW)).toBe(NOW + FALLBACK_PAUSE)
  expect(pauseUntil(null, 'gh: command not found', NOW)).toBeNull()
})

test('the pause message names a clock time', () => {
  expect(pauseMessage(NOW)).toMatch(/Paused until \d\d:\d\d/)
})

test('If-None-Match is sent only when there is an ETag', () => {
  expect(buildArgs('repos/o/r/x')).toEqual(['gh', 'api', '-i', 'repos/o/r/x'])
  expect(buildArgs('repos/o/r/x', 'W/"a"')).toEqual(['gh', 'api', '-i', '-H', 'If-None-Match: W/"a"', 'repos/o/r/x'])
})

test('the cache drops the oldest entry when full, and a re-used entry counts as new', () => {
  const cache = new Map<string, CacheEntry>()

  for (let i = 0; i < MAX_CACHE; i++) {
    remember(cache, `k${i}`, { etag: `e${i}`, body: '' })
  }

  remember(cache, 'k0', { etag: 'e0', body: '' })
  remember(cache, 'new', { etag: 'n', body: '' })
  expect(cache.size).toBe(MAX_CACHE)
  expect(cache.has('k0')).toBe(true)
  expect(cache.has('k1')).toBe(false)
  expect(cache.has('new')).toBe(true)
})

test('run lists ask for one status and map to the fields the pane uses', () => {
  expect(runsEndpoint('queued')).toContain('status=queued')
  const body = JSON.stringify({
    workflow_runs: [{ id: 7, name: 'CI', head_branch: 'main', status: 'in_progress' }, { id: 8, name: null, head_branch: null, status: 'queued' }],
  })
  expect(runsFrom(body)).toEqual([
    { databaseId: 7, workflowName: 'CI', headBranch: 'main', status: 'in_progress' },
    { databaseId: 8, workflowName: '', headBranch: '', status: 'queued' },
  ])
  expect(runsFrom('not json')).toEqual([])
})
