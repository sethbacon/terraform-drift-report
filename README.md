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
| `callback-allowed-hosts` | `""` | hosts the callback may be sent to (see [Callback egress](#callback-egress)) |

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

## Callback egress

`callback-url` is operator-supplied and the POST carries the `callback-token`
bearer, so the destination is authorized before the request is issued **and
again on every redirect hop** — a hop re-sends the same credential, so it is
exactly as sensitive as the first destination.

- **`callback-allowed-hosts` empty (default).** Any public host is permitted.
  A destination that *is* — or that *resolves to* — a private, link-local,
  carrier-grade-NAT or otherwise reserved address is refused, including the
  cloud instance-metadata service at `169.254.169.254`. The classification is
  numeric, so `127.1`, `2130706433`, `0x7f000001`, `017700000001` and
  `[::ffff:127.0.0.1]` are all recognised as loopback.
- **`callback-allowed-hosts` set.** Only the listed hosts are permitted, on
  every hop — which is how a deliberately-private, self-hosted TSM endpoint
  stays reachable. Entries are comma/newline-separated hostnames, IP literals,
  or single-label wildcards (`*.tsm.example.com` covers
  `drift.tsm.example.com` but not `a.drift.tsm.example.com`). An entry that
  cannot mean what you intended (`*.com`, a trailing `*`, an embedded port)
  fails the step rather than degrading to a weaker allowlist.

The initial URL is authorized on its hostname, so `https://tsm.example.com:8443/`
works under a `tsm.example.com` pin; a *redirect* onto a non-default port is
refused, so a pin cannot be widened to another port on the same host.

Only `https://` URLs are accepted, and the callback is bounded by a 60s timeout.

The host-authorization primitives come from
[`@4cloudguru/pipeline-task-core`](https://www.npmjs.com/package/@4cloudguru/pipeline-task-core),
shared with the Azure Pipelines task extensions, so this action and they cannot
drift apart.

## Contract

The count/summary semantics match the TSM backend's `driftingest` package
exactly; the test fixtures are vendored from the backend so they cannot diverge.
See the repo README ("Contract").
