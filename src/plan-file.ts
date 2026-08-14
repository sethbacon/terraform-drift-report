import * as fs from 'fs'
import * as path from 'path'

/**
 * Upper bound on the plan JSON this action will read into memory.
 *
 * Plan content is repository-derived, so on a fork PR an adversarial PR controls
 * how many resources and attributes get planned — and the parsed body is then
 * re-serialised (once pretty-printed for the report, once compact for the POST).
 * Nothing capped that chain. 256 MiB is far above any plausible real estate
 * (a 5,000-resource plan is single-digit MiB) while still bounding the
 * amplification to something a runner survives.
 */
export const MAX_PLAN_BYTES = 256 * 1024 * 1024

/**
 * Reads the plan JSON, refusing two shapes before anything is loaded.
 *
 * `plan-json-file` is a workflow-author input, so the PATH is trusted by design.
 * The CONTENT at that path is not: on a fork PR the repository is
 * attacker-influenced, so a path that resolves inside the checkout can be
 * satisfied by a symlink the PR committed. `fs.readFileSync` follows it without
 * a word, and whatever it points at — a credentials file another step wrote —
 * lands in the report and, when a callback is configured, in the POST body.
 *
 * The refusal is deliberately narrow, because a symlink is not itself
 * suspicious: only a symlink whose target escapes BOTH `GITHUB_WORKSPACE` and
 * `RUNNER_TEMP` is refused. A plan regenerated in the same job, a symlink within
 * the checkout, and any ordinary path anywhere all keep working.
 */
export function readPlanFile(planFile: string): string {
  const stat = fs.lstatSync(planFile)
  if (stat.isSymbolicLink()) {
    const target = fs.realpathSync(planFile)
    const roots = [process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    )
    if (roots.length > 0 && !roots.some((root) => isWithin(root, target))) {
      throw new Error(
        `plan-json-file is a symlink pointing outside the workspace (${planFile} -> ${target}). ` +
          `Refusing to read it: the content of that path is not the plan this job produced. ` +
          `Pass the real path, or regenerate the plan JSON in this job.`,
      )
    }
  }

  // One descriptor from here on. `statSync(path)` then `readFileSync(path)`
  // resolves the path twice, so the size that was checked and the bytes that
  // are read are not guaranteed to be the same file — a check-then-use race
  // (CodeQL's js/file-system-race), and a pointless one, since fstat answers
  // the same question about the object already open.
  const fd = fs.openSync(planFile, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size > MAX_PLAN_BYTES) {
      throw new Error(
        `plan-json-file is ${size} bytes, above this action's ${MAX_PLAN_BYTES}-byte limit. ` +
          `The report is built in memory and serialised twice, so an unbounded plan is an ` +
          `unbounded allocation on the runner.`,
      )
    }
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * True when `target` is `root` itself or sits underneath it.
 *
 * `root` is resolved by attempting it, not by testing first: an
 * `existsSync`-then-`realpathSync` pair is a check-then-use race (CodeQL's
 * `js/file-system-race`), and here it is also pointless — the only thing the
 * test decided was which of two values to hand `path.relative`, which the catch
 * decides just as well without a window in between.
 */
function isWithin(root: string, target: string): boolean {
  let base: string
  try {
    base = fs.realpathSync(root)
  } catch {
    base = root
  }
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
