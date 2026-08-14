import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MAX_PLAN_BYTES, readPlanFile } from '../src/plan-file'

// `plan-json-file` is a workflow-author input, so the PATH is trusted. The
// CONTENT at that path is not: on a fork PR the checkout is
// attacker-influenced, and fs.readFileSync follows a committed symlink without
// a word — into the report file and, with a callback configured, into the POST
// body.

let workspace: string
let outside: string
const savedEnv = { ws: process.env.GITHUB_WORKSPACE, tmp: process.env.RUNNER_TEMP }

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
  process.env.GITHUB_WORKSPACE = workspace
  process.env.RUNNER_TEMP = path.join(workspace, '_temp')
  fs.mkdirSync(process.env.RUNNER_TEMP, { recursive: true })
})

afterEach(() => {
  process.env.GITHUB_WORKSPACE = savedEnv.ws
  process.env.RUNNER_TEMP = savedEnv.tmp
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('readPlanFile: symlinks', () => {
  it('reads an ordinary file', () => {
    const p = path.join(workspace, 'plan.json')
    fs.writeFileSync(p, '{"resource_changes":[]}')
    expect(readPlanFile(p)).toBe('{"resource_changes":[]}')
  })

  it('refuses a symlink whose target escapes the workspace and RUNNER_TEMP', () => {
    const secret = path.join(outside, 'credentials.json')
    fs.writeFileSync(secret, '{"aws_secret_access_key":"S3CRET"}')
    const link = path.join(workspace, 'plan.json')
    fs.symlinkSync(secret, link)
    expect(() => readPlanFile(link)).toThrow(/symlink pointing outside the workspace/)
  })

  // Narrow on purpose: a symlink is not itself suspicious, and refusing every
  // one of them would break ordinary layouts for no gain.
  it('allows a symlink whose target stays inside the workspace', () => {
    const real = path.join(workspace, 'real-plan.json')
    fs.writeFileSync(real, '{"resource_changes":[]}')
    const link = path.join(workspace, 'plan.json')
    fs.symlinkSync(real, link)
    expect(readPlanFile(link)).toBe('{"resource_changes":[]}')
  })

  it('allows a symlink whose target stays inside RUNNER_TEMP', () => {
    const real = path.join(process.env.RUNNER_TEMP as string, 'real-plan.json')
    fs.writeFileSync(real, '{"resource_changes":[]}')
    const link = path.join(workspace, 'plan.json')
    fs.symlinkSync(real, link)
    expect(readPlanFile(link)).toBe('{"resource_changes":[]}')
  })
})

describe('readPlanFile: size', () => {
  it('refuses a file above the cap without reading it', () => {
    const p = path.join(workspace, 'huge.json')
    // Sparse: the guard stats, so this costs no disk and proves the refusal
    // happens before the read rather than after it.
    const fd = fs.openSync(p, 'w')
    fs.ftruncateSync(fd, MAX_PLAN_BYTES + 1)
    fs.closeSync(fd)
    expect(() => readPlanFile(p)).toThrow(new RegExp(`above this action's ${MAX_PLAN_BYTES}-byte limit`))
  })

  it('accepts a file at exactly the cap', () => {
    const p = path.join(workspace, 'atcap.json')
    fs.writeFileSync(p, '{}')
    expect(fs.statSync(p).size).toBeLessThanOrEqual(MAX_PLAN_BYTES)
    expect(readPlanFile(p)).toBe('{}')
  })
})
