/**
 * SCOPE — custody of the on-disk report.
 *
 * The file is the exact callback body: up to 300 characters of before/after
 * values for every changed attribute, plus module provenance. It therefore has
 * the same custody requirements as the callback payload, and used to have none
 * — a fixed name under os.tmpdir() (NOT RUNNER_TEMP, the only directory the
 * runner clears between jobs), created 0644, never removed.
 *
 * DOES claim: the path is unpredictable and lands under RUNNER_TEMP when set;
 * the file is created 0600; an existing file or a pre-planted symlink at the
 * target is never written through; two runs never collide.
 *
 * Does NOT claim: that the file is removed at job end — that is action.yml's
 * `post:` step, which is a runner behaviour and is not exercised here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeReport, writeReportInto } from '../src/report-file'

let root: string
let saved: string | undefined

beforeEach(() => {
  saved = process.env.RUNNER_TEMP
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'))
  process.env.RUNNER_TEMP = root
})

afterEach(() => {
  if (saved === undefined) delete process.env.RUNNER_TEMP
  else process.env.RUNNER_TEMP = saved
  fs.rmSync(root, { recursive: true, force: true })
})

describe('report file custody', () => {
  it('writes under RUNNER_TEMP, not os.tmpdir()', () => {
    // os.tmpdir() survives the job; RUNNER_TEMP is cleared between jobs, which
    // is the whole difference for a file holding plan data.
    const file = writeReport({ a: 1 })
    expect(file.startsWith(root + path.sep)).toBe(true)
  })

  it('creates the file 0600', () => {
    const file = writeReport({ a: 1 })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('round-trips the body', () => {
    const body = { status: 'completed', drifted: true, summary: [{ address: 'aws_s3_bucket.x' }] }
    expect(JSON.parse(fs.readFileSync(writeReport(body), 'utf8'))).toEqual(body)
  })

  it('never collides across runs, so concurrent jobs cannot overwrite each other', () => {
    const paths = new Set(Array.from({ length: 25 }, () => writeReport({ a: 1 })))
    expect(paths.size).toBe(25)
  })

  it('does not follow a symlink planted at the target', () => {
    // The old fixed, predictable name made this reachable: a pre-created
    // symlink caused writeFileSync to truncate the target as the runner user.
    // Driven through writeReportInto so the production flags are what is under
    // test, rather than a copy of them restated in the assertion.
    const victim = path.join(root, 'victim.txt')
    fs.writeFileSync(victim, 'original')
    const dir = fs.mkdtempSync(path.join(root, 'planted-'))
    fs.symlinkSync(victim, path.join(dir, 'tsm-drift-report.json'))

    expect(() => writeReportInto(dir, { secret: 'plan-data' })).toThrow(/EEXIST/)
    expect(fs.readFileSync(victim, 'utf8')).toBe('original')
  })

  it('refuses to overwrite an existing report rather than truncating it', () => {
    const dir = fs.mkdtempSync(path.join(root, 'existing-'))
    fs.writeFileSync(path.join(dir, 'tsm-drift-report.json'), 'someone-elses-plan')
    expect(() => writeReportInto(dir, { a: 1 })).toThrow(/EEXIST/)
    expect(fs.readFileSync(path.join(dir, 'tsm-drift-report.json'), 'utf8')).toBe('someone-elses-plan')
  })

  it('falls back to os.tmpdir() when RUNNER_TEMP is unset', () => {
    delete process.env.RUNNER_TEMP
    const file = writeReport({ a: 1 })
    expect(file.startsWith(os.tmpdir() + path.sep)).toBe(true)
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })
})
