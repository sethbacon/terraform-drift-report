import * as core from '@actions/core'
import * as fs from 'fs'
import { Plan, summarize, moduleCallsPlan } from '@4cloudguru/terraform-drift-contract'
import { truncateForLog } from '@4cloudguru/pipeline-task-core'
import { describeError, postJson, resolveTlsTrust } from './callback'
import { createHostAuthorizer } from './egress'
import { readModuleLocks } from './module-locks'
import { writeReport } from './report-file'

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

    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as Plan
    const result = summarize(plan)

    // Always emit outputs + a JSON artifact, even with no callback configured.
    const includeProvenance = core.getBooleanInput('include-module-provenance')
    const detail = core.getInput('detail')

    const body: Record<string, unknown> = {
      status: 'completed',
      added: result.added,
      changed: result.changed,
      destroyed: result.destroyed,
      drifted: result.drifted,
      summary: result.summary,
      detail,
    }
    if (includeProvenance) {
      body.plan = moduleCallsPlan(plan)
      body.module_locks = readModuleLocks(core.getInput('module-manifest') || '.terraform/modules/modules.json')
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
        tlsTrust,
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
