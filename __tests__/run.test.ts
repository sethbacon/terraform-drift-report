import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// src/index.ts — all the orchestration, every output, and the ordering that
// keeps the callback token out of the log — had no test at any point. It calls
// `void run()` on import, so each case re-imports it against a fresh mock set.
//
// The ordering assertions are the ones that matter most: core.setSecret's mask
// is not retroactive, so a refactor that moves it below any earlier throw, or
// below the POST, reintroduces a cleartext-token-in-log path with nothing
// failing.

const calls: string[] = []
const inputs = new Map<string, string>()
const outputs = new Map<string, string>()
const warnings: string[] = []
const failures: string[] = []

vi.mock('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  getBooleanInput: (name: string) => (inputs.get(name) ?? 'false').toLowerCase() === 'true',
  setSecret: (value: string) => calls.push(`setSecret:${value}`),
  setOutput: (name: string, value: string) => {
    outputs.set(name, value)
  },
  saveState: () => undefined,
  info: () => calls.push('info'),
  debug: () => calls.push('debug'),
  warning: (message: string) => {
    warnings.push(message)
    calls.push('warning')
  },
  setFailed: (message: string) => {
    failures.push(message)
    calls.push('setFailed')
  },
}))

const postJson = vi.fn(async () => ({ status: 200, body: 'ok' }))
vi.mock('../src/callback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/callback')>()
  return {
    ...actual,
    postJson: (...args: unknown[]) => {
      calls.push('postJson')
      return postJson(...(args as []))
    },
  }
})

let workspace: string
const saved = { ws: process.env.GITHUB_WORKSPACE, tmp: process.env.RUNNER_TEMP }

const PLAN = JSON.stringify({
  resource_changes: [
    { address: 'aws_instance.x', change: { actions: ['update'], before: { size: 1 }, after: { size: 2 } } },
    { address: 'aws_s3_bucket.y', change: { actions: ['create'], before: null, after: {} } },
  ],
})

function planAt(contents = PLAN): string {
  const p = path.join(workspace, 'plan.json')
  fs.writeFileSync(p, contents)
  return p
}

async function runAction(): Promise<void> {
  vi.resetModules()
  await import('../src/index')
  // `void run()` is fired at import; let its microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  calls.length = 0
  warnings.length = 0
  failures.length = 0
  inputs.clear()
  outputs.clear()
  postJson.mockClear()
  postJson.mockResolvedValue({ status: 200, body: 'ok' })
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'))
  process.env.GITHUB_WORKSPACE = workspace
  process.env.RUNNER_TEMP = path.join(workspace, '_temp')
  fs.mkdirSync(process.env.RUNNER_TEMP, { recursive: true })
  inputs.set('include-module-provenance', 'false')
})

afterEach(() => {
  process.env.GITHUB_WORKSPACE = saved.ws
  process.env.RUNNER_TEMP = saved.tmp
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe('run: happy path', () => {
  it('sets every documented output and writes the report', async () => {
    inputs.set('plan-json-file', planAt())
    await runAction()

    expect(failures).toEqual([])
    expect(outputs.get('drifted')).toBe('true')
    expect(outputs.get('added')).toBe('1')
    expect(outputs.get('changed')).toBe('1')
    expect(outputs.get('destroyed')).toBe('0')
    const report = outputs.get('summary-file') as string
    expect(fs.existsSync(report)).toBe(true)
    const body = JSON.parse(fs.readFileSync(report, 'utf8')) as Record<string, unknown>
    expect(body.status).toBe('completed')
    expect(body.drifted).toBe(true)
    expect(body.summary).toHaveLength(2)
  })

  it('a clean plan reports drifted=false and does not fail the step', async () => {
    inputs.set('plan-json-file', planAt(JSON.stringify({ resource_changes: [] })))
    inputs.set('fail-on-drift', 'true')
    await runAction()
    expect(outputs.get('drifted')).toBe('false')
    expect(failures).toEqual([])
  })

  it('fail-on-drift fails the step when there is drift', async () => {
    inputs.set('plan-json-file', planAt())
    inputs.set('fail-on-drift', 'true')
    await runAction()
    expect(failures[0]).toMatch(/Drift detected: 2 changed resource/)
  })
})

describe('run: the callback token is masked before anything can print it', () => {
  it('setSecret runs before the POST', async () => {
    inputs.set('plan-json-file', planAt())
    inputs.set('callback-url', 'https://tsm.example.com/drift')
    inputs.set('callback-token', 'tsm_TOKEN')
    await runAction()

    expect(failures).toEqual([])
    const masked = calls.indexOf('setSecret:tsm_TOKEN')
    const posted = calls.indexOf('postJson')
    expect(masked).toBeGreaterThanOrEqual(0)
    expect(posted).toBeGreaterThan(masked)
  })

  // The mask is job-scoped and cannot be applied retroactively, so it has to
  // beat every OTHER failure too — not just the ones on the callback path.
  it('setSecret runs before an early input failure', async () => {
    inputs.set('plan-json-file', planAt())
    inputs.set('callback-token', 'tsm_TOKEN')
    inputs.set('reject-unauthorized', 'false') // withdrawn switch: throws
    await runAction()

    expect(failures[0]).toMatch(/no longer accepts a false value/)
    // `indexOf` alone would pass at -1, i.e. with setSecret deleted entirely.
    expect(calls).toContain('setSecret:tsm_TOKEN')
    expect(calls.indexOf('setSecret:tsm_TOKEN')).toBeLessThan(calls.indexOf('setFailed'))
  })

  it('setSecret runs before the plan file is even opened', async () => {
    inputs.set('plan-json-file', path.join(workspace, 'missing.json'))
    inputs.set('callback-token', 'tsm_TOKEN')
    await runAction()

    expect(failures[0]).toMatch(/plan-json-file does not exist/)
    expect(calls[0]).toBe('setSecret:tsm_TOKEN')
  })
})

describe('run: callback configuration', () => {
  it.each([
    ['only the url', 'https://tsm.example.com/drift', ''],
    ['only the token', '', 'tsm_TOKEN'],
  ])('%s warns and skips the POST', async (_label, url, token) => {
    inputs.set('plan-json-file', planAt())
    inputs.set('callback-url', url)
    inputs.set('callback-token', token)
    await runAction()

    expect(warnings.join(' ')).toMatch(/Both callback-url and callback-token are required/)
    expect(postJson).not.toHaveBeenCalled()
    expect(failures).toEqual([])
  })

  it('a non-2xx response fails the step with a BOUNDED body', async () => {
    postJson.mockResolvedValue({ status: 500, body: 'x'.repeat(5000) })
    inputs.set('plan-json-file', planAt())
    inputs.set('callback-url', 'https://tsm.example.com/drift')
    inputs.set('callback-token', 'tsm_TOKEN')
    await runAction()

    expect(failures[0]).toMatch(/Drift callback failed \(HTTP 500\)/)
    // The peer chooses this text. It reaches a Checks annotation, so its length
    // is the action's decision, not the peer's; the full body goes to debug.
    expect(failures[0].length).toBeLessThan(400)
    expect(calls).toContain('debug')
  })
})

describe('run: diagnostics name the stage that failed', () => {
  it('malformed plan JSON names the file and the stage', async () => {
    inputs.set('plan-json-file', planAt('{ not json'))
    await runAction()
    expect(failures[0]).toMatch(/Failed to read plan JSON at .*plan\.json:/)
  })

  it('a corrupt module manifest warns instead of dropping provenance silently', async () => {
    const manifest = path.join(workspace, 'modules.json')
    fs.writeFileSync(manifest, 'not json at all')
    inputs.set('plan-json-file', planAt())
    inputs.set('include-module-provenance', 'true')
    inputs.set('module-manifest', manifest)
    await runAction()

    expect(failures).toEqual([])
    expect(warnings.join(' ')).toMatch(/module-manifest: .*could not be read as JSON/)
    const body = JSON.parse(fs.readFileSync(outputs.get('summary-file') as string, 'utf8')) as Record<string, unknown>
    expect(body.module_locks).toBeNull()
  })

  it('an absent module manifest is silent (the documented case)', async () => {
    inputs.set('plan-json-file', planAt())
    inputs.set('include-module-provenance', 'true')
    inputs.set('module-manifest', path.join(workspace, 'nope.json'))
    await runAction()

    expect(warnings).toEqual([])
    expect(failures).toEqual([])
  })

  // action.yml already declares the default, so the removed `||` fallback was
  // unreachable — except for the one case where it did fire, and overrode an
  // author's explicit opt-out.
  it('an empty module-manifest opts out instead of silently using the default', async () => {
    fs.mkdirSync(path.join(workspace, '.terraform', 'modules'), { recursive: true })
    fs.writeFileSync(
      path.join(workspace, '.terraform', 'modules', 'modules.json'),
      JSON.stringify({ Modules: [{ Key: 'k', Source: 'git::https://t0ken@example.com/m.git', Version: '1.0.0' }] }),
    )
    const cwd = process.cwd()
    process.chdir(workspace)
    try {
      inputs.set('plan-json-file', planAt())
      inputs.set('include-module-provenance', 'true')
      inputs.set('module-manifest', '')
      await runAction()
    } finally {
      process.chdir(cwd)
    }

    const body = JSON.parse(fs.readFileSync(outputs.get('summary-file') as string, 'utf8')) as Record<string, unknown>
    expect(body.module_locks).toBeNull()
    expect(warnings).toEqual([])
  })
})
