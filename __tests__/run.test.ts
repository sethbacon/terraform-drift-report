import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { summarize, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_ATTRS_PER_ENTRY } from '@4cloudguru/terraform-drift-contract'

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
const infos: string[] = []
const failures: string[] = []

vi.mock('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  getBooleanInput: (name: string) => (inputs.get(name) ?? 'false').toLowerCase() === 'true',
  setSecret: (value: string) => calls.push(`setSecret:${value}`),
  setOutput: (name: string, value: string) => {
    outputs.set(name, value)
  },
  saveState: () => undefined,
  info: (message: string) => {
    infos.push(message)
    calls.push('info')
  },
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
const saved = {
  ws: process.env.GITHUB_WORKSPACE,
  tmp: process.env.RUNNER_TEMP,
  // These tests run ON a GitHub runner, which exports a real GITHUB_SHA. Left
  // in place it would leak into every case as an incidental commit_sha, so it
  // is cleared per test and each case sets what it means to assert about.
  sha: process.env.GITHUB_SHA,
}

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
  // Extension-ful because tsconfig resolves as Node does: a dynamic import() is
  // an ESM resolution even from a CommonJS file, and ESM does no extension
  // guessing. Static imports elsewhere in this suite stay bare — those are
  // CommonJS `require` calls, which do.
  await import('../src/index.js')
  // `void run()` is fired at import; let its microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  calls.length = 0
  warnings.length = 0
  infos.length = 0
  failures.length = 0
  inputs.clear()
  outputs.clear()
  postJson.mockClear()
  postJson.mockResolvedValue({ status: 200, body: 'ok' })
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'))
  process.env.GITHUB_WORKSPACE = workspace
  process.env.RUNNER_TEMP = path.join(workspace, '_temp')
  fs.mkdirSync(process.env.RUNNER_TEMP, { recursive: true })
  delete process.env.GITHUB_SHA
  inputs.set('include-module-provenance', 'false')
})

afterEach(() => {
  process.env.GITHUB_WORKSPACE = saved.ws
  process.env.RUNNER_TEMP = saved.tmp
  if (saved.sha === undefined) delete process.env.GITHUB_SHA
  else process.env.GITHUB_SHA = saved.sha
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

// Nothing tied a report to the tree it described: the payload carried counts, a
// summary and a free-text detail, so two reports for the same state were ordered
// only by arrival time and a re-run on an older commit read as the current
// state. These assert the binding exists, defaults itself, and stays absent
// rather than empty when there is genuinely nothing to bind to.
describe('run: the report is bound to the commit it was computed from', () => {
  const SHA = '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12'

  function reportBody(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(outputs.get('summary-file') as string, 'utf8'))
  }

  it('defaults commit_sha to the commit the workflow ran on', async () => {
    process.env.GITHUB_SHA = SHA
    inputs.set('plan-json-file', planAt())
    await runAction()

    expect(failures).toEqual([])
    expect(reportBody().commit_sha).toBe(SHA)
  })

  it('an explicit commit-sha input wins over GITHUB_SHA', async () => {
    const EXPLICIT = '9f1c0de5b8a74e2d3c6b1a0f4e7d8c9b0a1b2c3d'
    process.env.GITHUB_SHA = SHA
    inputs.set('commit-sha', EXPLICIT)
    inputs.set('plan-json-file', planAt())
    await runAction()

    expect(reportBody().commit_sha).toBe(EXPLICIT)
  })

  // Absent, not empty. A receiver has to be able to tell "this runner had no
  // commit" from "an older action that never sent one", and `commit_sha: ""`
  // reads as the former while meaning neither.
  it('omits commit_sha entirely when there is no commit to report', async () => {
    inputs.set('plan-json-file', planAt())
    await runAction()

    const body = reportBody()
    expect(body.commit_sha).toBeUndefined()
    expect(Object.keys(body)).not.toContain('commit_sha')
  })

  // The report file is documented as "the exact callback body". Asserting the
  // field in the file alone would pass on a refactor that assembled the POST
  // separately and dropped it.
  it('the POSTed body carries the same commit_sha as the report file', async () => {
    process.env.GITHUB_SHA = SHA
    inputs.set('plan-json-file', planAt())
    inputs.set('callback-url', 'https://tsm.example.com/drift')
    inputs.set('callback-token', 'tsm_TOKEN')
    await runAction()

    expect(failures).toEqual([])
    expect(postJson).toHaveBeenCalledTimes(1)
    // The mock is declared with no parameters, so its recorded call is typed as
    // an empty tuple; the real call is postJson(url, headers, body, ...).
    const args = postJson.mock.calls[0] as unknown as unknown[]
    const posted = JSON.parse(args[2] as string)
    expect(posted.commit_sha).toBe(SHA)
    expect(posted.commit_sha).toBe(reportBody().commit_sha)
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

describe('run: no plan-derived text reaches an unescaped log sink', () => {
  // core.info is a bare process.stdout.write with no escaping at all, unlike
  // warning/error/setFailed, which route through issueCommand's escapeData. The
  // margin is thin rather than absent: both call sites interpolate numbers
  // today, so a future change that logs a resource address or an attribute
  // value would hand the runner's command parser an attacker-authored line.
  it('a hostile address and attribute value stay out of every core.info line', async () => {
    const hostile = '::error::forged\n::add-mask::x'
    inputs.set(
      'plan-json-file',
      planAt(
        JSON.stringify({
          resource_changes: [
            {
              address: hostile,
              change: { actions: ['update'], before: { k: hostile }, after: { k: hostile + '2' } },
            },
          ],
        }),
      ),
    )
    await runAction()

    expect(failures).toEqual([])
    expect(infos.length).toBeGreaterThan(0)
    for (const line of infos) {
      expect(line).not.toContain('::')
      expect(line).not.toContain('\n')
    }
    // It IS in the report — that is the action's purpose — so the assertion
    // above is about the log sink, not about dropping the data.
    const body = JSON.parse(fs.readFileSync(outputs.get('summary-file') as string, 'utf8')) as {
      summary: { address: string }[]
    }
    expect(body.summary[0].address).toBe(hostile)
  })
})

// The completeness markers — what the check did NOT do.
//
// The body used to be assembled by naming the contract's fields one at a time,
// which meant it described the contract as of the day the list was written.
// Contract 1.2.0 added five markers and every one of them was dropped here, so
// a plan this action could not read left the runner as `drifted: false` with
// zero counts — byte-identical to a verified-clean run. TSM auto-resolved the
// live drift record on it, which is the fail-open these markers exist to name.
//
// Every case below asserts BOTH directions. A body that hardcoded
// `unparseable: false` passes any test that only ever feeds it a readable plan,
// and one that hardcoded `true` passes any test that only feeds it a broken
// one; only the pair distinguishes a forwarded value from a constant.
describe('run: the completeness markers reach the wire', () => {
  const MARKERS = ['unparseable', 'unmasked', 'truncated', 'omitted_entries', 'omitted_attrs'] as const

  function reportBody(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(outputs.get('summary-file') as string, 'utf8'))
  }

  function postedBody(): Record<string, unknown> {
    expect(postJson).toHaveBeenCalledTimes(1)
    const args = postJson.mock.calls[0] as unknown as unknown[]
    return JSON.parse(args[2] as string)
  }

  // The report file is documented as the exact callback body, so both are read:
  // a refactor that assembled the POST separately would keep one right and send
  // the other.
  async function runWith(plan: unknown): Promise<Record<string, unknown>> {
    inputs.set('plan-json-file', planAt(JSON.stringify(plan)))
    inputs.set('callback-url', 'https://tsm.example.com/drift')
    inputs.set('callback-token', 'tsm_TOKEN')
    await runAction()
    expect(failures).toEqual([])
    const posted = postedBody()
    for (const marker of MARKERS) expect(posted[marker]).toEqual(reportBody()[marker])
    return posted
  }

  const UNREADABLE = {}
  const CLEAN = { resource_changes: [] }
  const UNMASKED = {
    resource_changes: [
      { address: 'aws_instance.x', change: { actions: ['update'], before: { size: 1 }, after: { size: 2 } } },
    ],
  }
  const MASKED = {
    resource_changes: [
      {
        address: 'aws_instance.x',
        change: {
          actions: ['update'],
          before: { size: 1 },
          after: { size: 2 },
          before_sensitive: {},
          after_sensitive: {},
        },
      },
    ],
  }
  const TOO_MANY_ENTRIES = {
    resource_changes: Array.from({ length: DEFAULT_MAX_ENTRIES + 3 }, (_unused, i) => ({
      address: `aws_s3_bucket.b${i}`,
      change: { actions: ['create'], before: null, after: {} },
    })),
  }
  const attrs = (n: number, base: number): Record<string, number> =>
    Object.fromEntries(Array.from({ length: n }, (_unused, i) => [`k${i}`, base + i]))
  const TOO_MANY_ATTRS = {
    resource_changes: [
      {
        address: 'aws_instance.w',
        change: {
          actions: ['update'],
          before: attrs(DEFAULT_MAX_ATTRS_PER_ENTRY + 4, 0),
          after: attrs(DEFAULT_MAX_ATTRS_PER_ENTRY + 4, 1000),
          before_sensitive: {},
          after_sensitive: {},
        },
      },
    ],
  }

  // The load-bearing one. This body is `added:0 changed:0 destroyed:0
  // drifted:false` — indistinguishable from CLEAN below on every other field.
  // `unparseable` is the ONLY thing separating "we checked and it was clean"
  // from "we never finished checking".
  it('an unreadable document is reported as unparseable, not as clean', async () => {
    const posted = await runWith(UNREADABLE)
    expect(posted.unparseable).toBe(true)
    expect([posted.added, posted.changed, posted.destroyed, posted.drifted]).toEqual([0, 0, 0, false])
  })

  // Positive control for the above: the false value has to travel too, or the
  // marker is a constant and the assertion above proves nothing.
  it('a genuinely clean plan is reported as parseable', async () => {
    const posted = await runWith(CLEAN)
    expect(posted.unparseable).toBe(false)
    expect([posted.added, posted.changed, posted.destroyed, posted.drifted]).toEqual([0, 0, 0, false])
  })

  it('a change with no sensitivity metadata sets unmasked', async () => {
    expect((await runWith(UNMASKED)).unmasked).toBe(true)
  })

  it('a change carrying sensitivity mirrors does not', async () => {
    expect((await runWith(MASKED)).unmasked).toBe(false)
  })

  it('a capped summary reports how many rows were dropped', async () => {
    const posted = await runWith(TOO_MANY_ENTRIES)
    expect(posted.truncated).toBe(true)
    expect(posted.omitted_entries).toBe(3)
    // The counts are NOT capped, so `drifted` stays truthful: 503 creates, 500
    // rows. That difference is only legible because omitted_entries is present.
    expect(posted.added).toBe(DEFAULT_MAX_ENTRIES + 3)
    expect((posted.summary as unknown[]).length).toBe(DEFAULT_MAX_ENTRIES)
  })

  it('a capped attribute list reports how many attrs were dropped', async () => {
    const posted = await runWith(TOO_MANY_ATTRS)
    expect(posted.truncated).toBe(true)
    expect(posted.omitted_attrs).toBe(4)
  })

  it('an uncapped report says so rather than staying silent', async () => {
    const posted = await runWith(UNMASKED)
    expect(posted.truncated).toBe(false)
    expect(posted.omitted_entries).toBe(0)
    expect(posted.omitted_attrs).toBe(0)
  })

  // The class guard, and the reason the body is a spread rather than a pick
  // list: this fails on the NEXT field the contract adds, not just on the five
  // that were dropped this time. It reads the real package, so a contract bump
  // that widens Result reddens here in the consumer that emits the payload.
  it('every field the contract computes is forwarded, not just the ones named here', async () => {
    const posted = await runWith(TOO_MANY_ENTRIES)
    const computed = summarize(TOO_MANY_ENTRIES)
    const dropped = Object.keys(computed).filter((k) => !(k in posted))
    expect(dropped).toEqual([])
    for (const marker of MARKERS) {
      expect(posted[marker]).toEqual((computed as unknown as Record<string, unknown>)[marker])
    }
  })

  // The names are not this repo's to choose. TSM decodes them as the json tags
  // of `completeness` in internal/api/drift_records.go, and its own generated jq
  // templates already post exactly these keys; a rename here is a silent drop
  // there, because the callback deliberately does not use DisallowUnknownFields.
  it('uses the snake_case wire names the receiver decodes', async () => {
    const posted = await runWith(UNMASKED)
    for (const marker of MARKERS) expect(Object.keys(posted)).toContain(marker)
  })
})
