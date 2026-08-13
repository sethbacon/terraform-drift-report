import * as fs from 'fs'
import { moduleCallsPlan } from '@4cloudguru/terraform-drift-contract'

/**
 * The fields of a `.terraform/modules/modules.json` entry that carry
 * provenance. The backend's `driftingest.ParseModuleLocks` reads `Source` and
 * `Version` to join a registry module to its LOCKED version; `Key` names the
 * module call the lock belongs to. Every other member — notably `Dir`, the
 * runner-local checkout path — is dropped by construction, so a Terraform field
 * added later cannot ride along unreviewed.
 */
export interface ModuleLock {
  Key?: string
  Source?: string
  Version?: string
}

/**
 * Strips credentials from a module source address using the CONTRACT's own
 * scrubber, reached through `moduleCallsPlan` — the exported entry point that
 * applies it — rather than a second local copy of the logic.
 *
 * `module_locks` and `module_calls` therefore cannot drift apart: the identical
 * source string is redacted identically in both, and a contract upgrade
 * improves both at once. That matters here because the two fields carry the
 * SAME addresses: `modules.json` is Terraform's resolved view of the very
 * `source` arguments the plan's configuration block reports, so a
 * `git::https://x-access-token:ghp_…@github.com/org/mod.git` scrubbed out of
 * one was, until now, forwarded verbatim by the other.
 *
 * The scrubber is module-private inside `@4cloudguru/terraform-drift-contract`
 * and is not exported; `@4cloudguru/pipeline-task-core`'s `redactUrlUserInfo`
 * is not a substitute, because it strips only URL userinfo and leaves
 * go-getter's credential-bearing query parameters (`sshkey=`,
 * `X-Amz-Signature=`, `token=`) intact.
 */
function scrubSource(source: string): string {
  const projected = moduleCallsPlan({
    configuration: { root_module: { module_calls: { m: { source } } } },
  }) as { configuration: { root_module: { module_calls: { m?: { source?: string } } } } }
  return projected.configuration.root_module.module_calls.m?.source ?? ''
}

/** Projects the manifest's `Modules` array down to provenance, scrubbing each source. */
export function projectModuleLocks(modules: unknown): ModuleLock[] {
  if (!Array.isArray(modules)) return []
  return modules.map((entry) => {
    const lock = (typeof entry === 'object' && entry !== null ? entry : {}) as ModuleLock
    const out: ModuleLock = {}
    if (typeof lock.Key === 'string') out.Key = lock.Key
    if (typeof lock.Source === 'string') out.Source = scrubSource(lock.Source)
    if (typeof lock.Version === 'string') out.Version = lock.Version
    return out
  })
}

/**
 * Reads `.terraform/modules/modules.json` for the callback's `module_locks`
 * field; returns null when absent or unreadable (the backend then records
 * provenance without locked versions, exactly as the jq template does).
 *
 * The manifest is PROJECTED, never forwarded verbatim: it is written by
 * Terraform from operator-supplied module sources, so its `Source` entries
 * carry whatever credential the source address embeds, and the callback body is
 * both POSTed and written to a world-readable temp file.
 */
export function readModuleLocks(manifestPath: string): unknown {
  try {
    if (!fs.existsSync(manifestPath)) return null
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { Modules?: unknown }
    return { Modules: projectModuleLocks(raw?.Modules) }
  } catch {
    return null
  }
}
