import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Removes the report written by the main entrypoint.
 *
 * The report holds unredacted before/after attribute values and, when module
 * provenance is on, the module configuration and lockfile. Without a `post:`
 * step it stayed on the runner filesystem for the life of the machine — on a
 * GitHub-hosted VM that is the job, but on a self-hosted runner it is until
 * someone cleans up.
 *
 * Best-effort by design: a cleanup failure must not turn a green drift run red,
 * so every error is reported through `core.debug` rather than `setFailed`. The
 * whole `mkdtemp` directory goes, since the main step owns it exclusively.
 */
export function cleanup(): void {
  const file = core.getState('summary-file')
  if (!file) return
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    core.debug(`Removed drift report at ${file}`)
  } catch (error) {
    core.debug(`Could not remove drift report at ${file}: ${String(error)}`)
  }
}

cleanup()
