export type Step = { name: string; status: string; conclusion: string | null }

export type Job = {
  name: string
  run: string
  branch: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  done: number
  total: number
  steps?: Step[]
}

export type Lane = {
  key: string
  online: boolean | null
  jobs: Job[]
}

declare module 'claude-code' {
  interface PluginState {
    'ci-progress': { lanes: Lane[]; error: string | null; open: string[]; pulse: boolean }
  }
}
