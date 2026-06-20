import * as core from '@actions/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plan, summarize, moduleCallsPlan } from 'terraform-drift-contract'
import { postJson } from './callback'

/** Reads `.terraform/modules/modules.json` verbatim for the callback's
 *  module_locks field; returns null when absent or unreadable (the backend then
 *  records provenance without locked versions, exactly as the jq template does). */
function readModuleLocks(manifestPath: string): unknown {
  try {
    if (!fs.existsSync(manifestPath)) return null
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

async function run(): Promise<void> {
  try {
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

    const summaryFile = path.join(os.tmpdir(), 'tsm-drift-report.json')
    fs.writeFileSync(summaryFile, JSON.stringify(body, null, 2), 'utf8')

    core.setOutput('drifted', String(result.drifted))
    core.setOutput('added', String(result.added))
    core.setOutput('changed', String(result.changed))
    core.setOutput('destroyed', String(result.destroyed))
    core.setOutput('summary-file', summaryFile)

    core.info(
      `Drift: drifted=${result.drifted} added=${result.added} changed=${result.changed} ` +
        `destroyed=${result.destroyed} (${result.summary.length} changed resources)`,
    )

    // Optional callback to the TSM drift endpoint.
    const callbackUrl = core.getInput('callback-url')
    const callbackToken = core.getInput('callback-token')
    if (callbackUrl && callbackToken) {
      core.setSecret(callbackToken)
      const rejectUnauthorized = core.getBooleanInput('reject-unauthorized')
      const resp = await postJson(
        callbackUrl,
        { 'X-TSM-Callback-Token': callbackToken },
        JSON.stringify(body),
        rejectUnauthorized,
      )
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Drift callback failed (HTTP ${resp.status}): ${resp.body}`)
      }
      core.info(`Drift result posted to TSM (HTTP ${resp.status}).`)
    } else if (callbackUrl || callbackToken) {
      core.warning('Both callback-url and callback-token are required to POST results; skipping callback.')
    }

    if (result.drifted && core.getBooleanInput('fail-on-drift')) {
      core.setFailed(`Drift detected: ${result.summary.length} changed resource(s).`)
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

void run()
