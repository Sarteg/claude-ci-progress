import { test, expect } from 'claude-code/testing'

import {
  ACTIVE_STATUSES,
  bar,
  clip,
  dotState,
  laneOf,
  laneProgress,
  laneSteps,
  repoDirsFrom,
  summarize,
  uniqueRuns,
} from './register'

test('active runs are listed by status, so old busy runs are not cut off', () => {
  expect(ACTIVE_STATUSES).toContain('in_progress')
  expect(ACTIVE_STATUSES).toContain('queued')
  expect(ACTIVE_STATUSES).not.toContain('completed')
})

test('a run seen by two status calls counts once', () => {
  const a = { databaseId: 1, status: 'queued' }
  const b = { databaseId: 2, status: 'in_progress' }
  const a2 = { databaseId: 1, status: 'in_progress' }
  expect(uniqueRuns([[a, b], [a2]]).map(r => r.databaseId)).toEqual([1, 2])
  expect(uniqueRuns([[a, b], [a2]])[0].status).toBe('in_progress')
})

test('bar fills in proportion', () => {
  expect(bar(0, 10)).toBe('░'.repeat(10))
  expect(bar(0.5, 10)).toBe('█'.repeat(5) + '░'.repeat(5))
  expect(bar(1, 10)).toBe('█'.repeat(10))
})

test('jobs go to their runner, or to the queue', () => {
  expect(laneOf('in_progress', 'devbox-ci')).toBe('devbox-ci')
  expect(laneOf('queued', null)).toBe('queued')
  expect(laneOf('queued', 'devbox-ci')).toBe('queued')
  expect(laneOf('in_progress', null)).toBe('queued')
})

test('lane progress counts steps', () => {
  const job = (status: 'queued' | 'in_progress' | 'completed', done = 0, total = 0) => ({
    name: 'j', run: 'CI', branch: 'main', status, conclusion: null, done, total,
  })

  expect(laneSteps([job('in_progress', 11, 14)])).toEqual({ done: 11, total: 14 })
  expect(laneProgress([job('in_progress', 2, 4)])).toBe(0.5)
  expect(laneSteps([job('in_progress', 2, 4), job('completed', 6, 6)])).toEqual({ done: 8, total: 10 })
  expect(laneProgress([])).toBe(0)
})

test('repo scan keeps real repos and skips worktrees', () => {
  const out = ['/h/my-app/.git', '/h/my-app/worktrees/r1/.git', '/h/other/.git', '/h/x/node_modules/y/.git'].join('\n')

  expect(repoDirsFrom(out)).toEqual(['/h/my-app', '/h/other'])
})

test('clip cuts long text with an ellipsis', () => {
  expect(clip('short', 10)).toBe('short')
  expect(clip('abcdefghij', 5)).toBe('abcd…')
})

test('summary counts runners, running, queued and remaining', () => {
  const job = (status: 'queued' | 'in_progress' | 'completed') => ({
    name: 'j', run: 'CI', branch: 'main', status, conclusion: null, done: 0, total: 0,
  })
  const lanes = [
    { key: 'a', online: true, jobs: [job('in_progress')] },
    { key: 'b', online: true, jobs: [job('completed')] },
    { key: 'c', online: false, jobs: [] },
    { key: 'queued', online: null, jobs: [job('queued'), job('queued')] },
  ]

  expect(summarize(lanes)).toEqual({ runners: 3, running: 1, queued: 2, remaining: 3 })
})

test('dot colours: running, waiting, offline', () => {
  const job = (status: 'queued' | 'in_progress' | 'completed') => ({
    name: 'j', run: 'CI', branch: 'main', status, conclusion: null, done: 0, total: 0,
  })

  expect(dotState({ key: 'a', online: true, jobs: [job('in_progress')] })).toBe('running')
  expect(dotState({ key: 'a', online: true, jobs: [job('completed')] })).toBe('waiting')
  expect(dotState({ key: 'a', online: true, jobs: [] })).toBe('waiting')
  expect(dotState({ key: 'a', online: false, jobs: [] })).toBe('offline')
  expect(dotState({ key: 'queued', online: null, jobs: [job('queued')] })).toBe('none')
})
