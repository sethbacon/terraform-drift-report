import * as core from '@actions/core'
import * as fs from 'fs'
import { Plan, Result, summarize, moduleCallsPlan } from '@4cloudguru/terraform-drift-contract'
import { truncateForLog } from '@4cloudguru/pipeline-task-core'
import { describeError, postJson, resolveTlsTrust } from './callback'
import { createHostAuthorizer } from './egress'
import { readModuleLocks } from './module-locks'
import { readPlanFile } from './plan-file'
import { writeReport } from './report-file'

/**
 * The wire contract with TSM. It was assembled as a bare
 * `Record<string, unknown>`, so `tsc --noEmit` — the repo's whole "lint" —
 * could not catch a typo'd key, a wrong field type or a field dropped in a
 * refactor. The only thing that would notice was the backend, at run time, on
 * the one payload that leaves the runner with a credential attached.
 *
 * It then restated the contract's fields one by one, which reintroduced the
 * same failure in a slower form: the list could only ever describe the contract
 * as it stood the day it was written, and a field the contract added later was
 * dropped with nothing red. That is exactly what happened — contract 1.2.0 added
 * five completeness markers (`unparseable`, `unmasked`, `truncated`,
 * `omitted_entries`, `omitted_attrs`) and this body forwarded none of them, so a
 * plan the action could not read arrived at TSM as `drifted: false` and was
 * indistinguishable from a verified-clean one. TSM auto-resolved the drift
 * record on it.
 *
 * So `extends Result` rather than a copy of its members: the contract's own
 * type is the list, every field of it is REQUIRED here, and the body below is
 * built by spreading `result`. A field the contract adds next is forwarded by
 * construction, and deleting one becomes a compile error rather than a silent
 * omission. The wire names are the contract's field names unchanged, which is
 * also what the backend decodes (`completeness` in `internal/api/
 * drift_records.go`) and what its generated jq templates already post.
 */
export interface CallbackBody extends Result {
  status: string
  detail: string
  /**
   * The commit the plan was computed from. Omitted rather than sent empty, so a
   * receiver can tell "this runner had no commit to report" from "an older
   * action that never sent one" — the two need different answers, and a bare
   * `""` collapses them.
   *
   * snake_case to match the rest of this body and the fields TSM already
   * stores (`external_ref`, `state_key`, `module_locks`).
   */
  commit_sha?: string
  /** Module provenance; present only with include-module-provenance. */
  plan?: unknown
  module_locks?: unknown
}

async function run(): Promise<void> {
  try {
    // Registered before ANY other input is read or validated. The mask is
    // job-scoped and cannot be applied retroactively, so every early throw
    // between here and the callback used to leave the token printable — and a
    // per-run token typically arrives as a step output, which GitHub does not
    // mask on its own, making this call the only registration in the job.
    const callbackToken = core.getInput('callback-token')
    if (callbackToken) core.setSecret(callbackToken)

    // Resolved before anything else, and whether or not a callback is
    // configured, so that a `reject-unauthorized: false` left in a workflow is
    // refused wherever it is set rather than silently ignored.
    const tlsTrust = resolveTlsTrust(core.getInput('reject-unauthorized'), core.getInput('ca-cert'))

    const planFile = core.getInput('plan-json-file', { required: true })
    if (!fs.existsSync(planFile)) {
      throw new Error(
        `plan-json-file does not exist: ${planFile}. Provide the JSON output of ` +
          `'terraform show -json <plan>' (or 'tofu show -json <plan>').`,
      )
    }

    // Named stages. Everything in run() funnels into one catch, so a malformed
    // plan used to surface as a bare `Unexpected token } in JSON at position 42`
    // with no mention of which file, which stage, or that the file even was the
    // problem — strictly less than the not-found branch three lines above gives.
    let plan: Plan
    try {
      plan = JSON.parse(readPlanFile(planFile)) as Plan
    } catch (error) {
      throw new Error(`Failed to read plan JSON at ${planFile}: ${describeError(error)}`)
    }
    // `summarize` normalises every field it reads, so it does not throw on a
    // malformed document — but it is a separate stage and a future contract
    // version could, and "which stage" is the whole point of this shape.
    let result: ReturnType<typeof summarize>
    try {
      result = summarize(plan)
    } catch (error) {
      throw new Error(`Failed to summarize the plan at ${planFile}: ${describeError(error)}`)
    }

    // Always emit outputs + a JSON artifact, even with no callback configured.
    const includeProvenance = core.getBooleanInput('include-module-provenance')
    const detail = core.getInput('detail')

    // Falls back to the commit the workflow is running on rather than staying
    // empty. Drift reports are consumed as a time series, and until now the
    // payload carried no commit at all — so two reports for the same state were
    // ordered only by arrival time, a re-run against an older commit landed
    // after a newer one and read as current, and no report could be re-derived
    // against the tree it described. GITHUB_SHA is set by the runner for every
    // event, so the binding is present by default; an operator whose plan comes
    // from a different commit still overrides it.
    const commitSha = core.getInput('commit-sha') || process.env.GITHUB_SHA || ''

    // Spread, not a pick list. Everything the contract computed goes on the
    // wire, including the markers that say what this check did NOT do; only the
    // two fields the contract does not own are added here.
    const body: CallbackBody = {
      ...result,
      status: 'completed',
      detail,
    }
    if (commitSha) body.commit_sha = commitSha
    if (includeProvenance) {
      body.plan = moduleCallsPlan(plan)
      // No `|| '.terraform/modules/modules.json'` fallback: action.yml already
      // declares that default, so the fallback was unreachable under the
      // documented contract — and it overrode the ONE case where an empty value
      // is meaningful, an author passing `module-manifest: ""` to opt out. An
      // empty path simply finds no manifest and yields null, which is the
      // documented "absent" behaviour.
      //
      // "Absent" and "present but unreadable" used to collapse onto the same
      // silent null, so a mistyped path or a corrupt manifest dropped provenance
      // with no signal at all — noticed, if ever, as a missing field in the
      // callback body long afterwards.
      body.module_locks = readModuleLocks(core.getInput('module-manifest'), (message) =>
        core.warning(`module-manifest: ${message} Module provenance will omit locked versions.`),
      )
    }

    const summaryFile = writeReport(body)

    core.setOutput('drifted', String(result.drifted))
    core.setOutput('added', String(result.added))
    core.setOutput('changed', String(result.changed))
    core.setOutput('destroyed', String(result.destroyed))
    core.setOutput('summary-file', summaryFile)
    // Handed to the post step, which deletes it. saveState rather than an env
    // var so the value never appears in the job's environment.
    core.saveState('summary-file', summaryFile)

    core.info(
      `Drift: drifted=${result.drifted} added=${result.added} changed=${result.changed} ` +
        `destroyed=${result.destroyed} (${result.summary.length} changed resources)`,
    )

    // Optional callback to the TSM drift endpoint.
    const callbackUrl = core.getInput('callback-url')
    if (callbackUrl && callbackToken) {
      const resp = await postJson(
        callbackUrl,
        { 'X-TSM-Callback-Token': callbackToken },
        JSON.stringify(body),
        createHostAuthorizer(core.getInput('callback-allowed-hosts')),
        // setSecret so a proxy URL carrying `user:password@` — which arrives
        // from the runner's environment, not from an action input, so nothing
        // earlier in the run has masked it — is registered before the agent
        // that could echo it in a connection error is built.
        { ...tlsTrust, setSecret: core.setSecret },
      )
      if (resp.status < 200 || resp.status >= 300) {
        // The body is chosen by whatever host callback-url names. Pasting it
        // into the thrown Error put it in core.setFailed, i.e. straight into
        // the job log and the Checks annotation, at whatever length and with
        // whatever control characters the peer picked — setFailed escapes only
        // %, CR and LF. The full body stays available under ACTIONS_STEP_DEBUG.
        core.debug(`Drift callback response body: ${resp.body}`)
        throw new Error(
          `Drift callback failed (HTTP ${resp.status}): ${truncateForLog(resp.body, 256)}`,
        )
      }
      core.info(`Drift result posted to TSM (HTTP ${resp.status}).`)
    } else if (callbackUrl || callbackToken) {
      core.warning('Both callback-url and callback-token are required to POST results; skipping callback.')
    }

    if (result.drifted && core.getBooleanInput('fail-on-drift')) {
      core.setFailed(`Drift detected: ${result.summary.length} changed resource(s).`)
    }
  } catch (error) {
    core.setFailed(describeError(error))
  }
}

void run()
