import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Writes the drift report to a private, unpredictable path and returns it.
 *
 * The file is the exact callback body — up to 300 characters of before/after
 * values for every changed attribute, plus module provenance when it is
 * enabled — so it carries the same disclosure risk as the payload itself.
 *
 * Four properties, each closing a specific gap in the previous fixed-path
 * write:
 *
 *  - `RUNNER_TEMP` rather than `os.tmpdir()`. Only the former is cleared by the
 *    runner between jobs; `os.tmpdir()` resolves to `/tmp` and the report
 *    survived the step, the job and — on a non-ephemeral self-hosted runner —
 *    the whole run.
 *  - `mkdtempSync`, so the name is unpredictable. Two jobs sharing a runner
 *    used to collide on one hardcoded filename, which meant job A's
 *    `summary-file` output could point at a file job B had overwritten with a
 *    different repository's plan.
 *  - mode `0o600`, so another local user or a concurrent job cannot read it.
 *    `writeFileSync(p, data, 'utf8')` takes the third argument as the encoding,
 *    so the old call passed no mode at all and got 0644.
 *  - flag `wx`, which fails rather than following anything already at the path.
 *    Combined with the unpredictable directory this removes the pre-planted
 *    symlink case, where the write truncated an attacker-chosen file as the
 *    runner user.
 */
export function writeReport(body: unknown): string {
  const root = process.env.RUNNER_TEMP || os.tmpdir()
  return writeReportInto(fs.mkdtempSync(path.join(root, 'tsm-drift-')), body)
}

/**
 * The write itself, separated so the mode and the create-exclusive flag are
 * observable. `writeReport` always hands this a directory it just created, so
 * in production nothing can pre-exist at the path — but `wx` is what makes that
 * a guarantee rather than a consequence of the current caller, and a guard
 * whose failure mode is unreachable from its only caller is untestable and
 * therefore unverifiable. Exported for the suite, not part of the action's API.
 */
export function writeReportInto(dir: string, body: unknown): string {
  const file = path.join(dir, 'tsm-drift-report.json')
  fs.writeFileSync(file, JSON.stringify(body, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  return file
}
