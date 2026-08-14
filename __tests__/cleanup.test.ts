import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// The post step is what stops an unredacted report — before/after attribute
// values, module provenance, the whole callback body — from outliving the job
// on a self-hosted runner. It had no test, and it is a `post:` entry point, so
// nothing in a normal PR run exercises it either.

let state = ''
const debug: string[] = []

vi.mock('@actions/core', () => ({
  getState: () => state,
  debug: (message: string) => debug.push(message),
}))

let dir: string

beforeEach(() => {
  debug.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-drift-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function runCleanup(): Promise<void> {
  vi.resetModules()
  // See the note in run.test.ts: a dynamic import() resolves under ESM rules
  // even here, so the extension is not optional.
  await import('../src/cleanup.js')
}

describe('cleanup', () => {
  it('removes the whole report directory, not just the file', async () => {
    const file = path.join(dir, 'tsm-drift-report.json')
    fs.writeFileSync(file, '{"summary":[]}')
    state = file
    await runCleanup()
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('does nothing when no report was written', async () => {
    state = ''
    await runCleanup()
    expect(debug).toEqual([])
    expect(fs.existsSync(dir)).toBe(true)
  })

  // A cleanup failure must never turn a green drift run red.
  it('reports a failure through debug rather than failing the step', async () => {
    state = path.join(dir, 'nested', 'gone.json')
    await expect(runCleanup()).resolves.toBeUndefined()
  })
})
