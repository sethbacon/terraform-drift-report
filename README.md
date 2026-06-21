# drift-report

[![GitHub release](https://img.shields.io/github/v/release/sethbacon/terraform-drift-report?logo=github&label=Marketplace&color=2ea44f)](https://github.com/marketplace/actions/terraform-drift-report)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Parse a Terraform/OpenTofu plan JSON into Terraform State Manager (TSM) drift
counts + a changed-resource summary, emit them as outputs and a JSON artifact,
and optionally POST the result to a TSM drift callback. **Consume-only** — it
does not run `plan`.

Pair it with `setup-terraform-hardened` (no wrapper, so `-detailed-exitcode`
works) and your cloud's first-party OIDC auth action.

## Inputs

| Input | Default | Notes |
|-------|---------|-------|
| `plan-json-file` | — (required) | output of `terraform show -json` / `tofu show -json` |
| `module-manifest` | `.terraform/modules/modules.json` | resolved module lockfile for locked versions |
| `include-module-provenance` | `true` | include `module_calls` (+ `module_locks`) in the report |
| `fail-on-drift` | `false` | fail the step when drift is detected |
| `detail` | `""` | free-text run label forwarded as the callback `detail` |
| `callback-url` | `""` | TSM callback URL; POST happens only with both url + token |
| `callback-token` | `""` | per-run one-shot token (sent as `X-TSM-Callback-Token`) |
| `reject-unauthorized` | `true` | TLS verification for the callback |

## Outputs

| Output | Notes |
|--------|-------|
| `drifted` | `"true"` when any non-no-op, non-read change was planned |
| `added` / `changed` / `destroyed` | resource counts (replacement counts as add **and** destroy) |
| `summary-file` | path to the JSON report (the exact callback body) |

## Example

```yaml
- run: |
    terraform plan -detailed-exitcode -out=tfplan -input=false || true
    terraform show -json tfplan > plan.json
- uses: sethbacon/terraform-drift-report@v1
  with:
    plan-json-file: plan.json
    callback-url: ${{ secrets.TSM_CALLBACK_URL }}
    callback-token: ${{ secrets.TSM_CALLBACK_TOKEN }}
```

## Contract

The count/summary semantics match the TSM backend's `driftingest` package
exactly; the test fixtures are vendored from the backend so they cannot diverge.
See the repo README ("Contract").
