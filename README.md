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
| `include-module-provenance` | `true` | include projected `module_calls` (+ `module_locks`) in the report (see [Module provenance](#module-provenance)) |
| `fail-on-drift` | `false` | fail the step when drift is detected |
| `detail` | `""` | free-text run label forwarded as the callback `detail` |
| `callback-url` | `""` | TSM callback URL; POST happens only with both url + token |
| `callback-token` | `""` | per-run one-shot token (sent as `X-TSM-Callback-Token`) |
| `ca-cert` | `""` | PEM CA certificate for a callback endpoint behind a private CA (see [Private CAs](#private-cas)) |
| `reject-unauthorized` | `true` | **a false value now fails the step** (see [Private CAs](#private-cas)) |
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

## Private CAs

The callback carries the per-run `callback-token` as a bearer credential, plus
the full plan report, so the peer is always authenticated: both the certificate
chain **and** the hostname are verified, and there is no switch to turn that
off.

For a TSM endpoint whose certificate is issued by a **private CA** the runner
does not already trust, supply that CA certificate:

```yaml
- uses: sethbacon/terraform-drift-report@v1
  with:
    plan-json-file: plan.json
    callback-url: https://tsm.internal.example.com/api/v1/drift/ingest
    callback-token: ${{ secrets.TSM_CALLBACK_TOKEN }}
    ca-cert: ${{ secrets.INTERNAL_ROOT_CA_PEM }}   # PEM, may hold a chain
    callback-allowed-hosts: tsm.internal.example.com
```

Trusting the CA keeps verification on, which is the difference that matters: an
attacker who answers for the callback host still cannot present a certificate
your CA did not issue, so the token is not handed over. While `ca-cert` is set
it **replaces** the default trust store for the callback request, so a
publicly-trusted CA cannot vouch for an internal name either. `NODE_EXTRA_CA_CERTS`
on the runner works too, if you prefer to trust the CA process-wide.

> **`reject-unauthorized: false` was withdrawn.** It disabled certificate *and*
> hostname verification together, so any host that answered for the callback
> name — a hostile proxy, a spoofed DNS or ARP reply, a shared self-hosted
> runner network — received the per-run token and the whole plan report in
> full. Setting it now fails the step with a message pointing here. If you were
> using it for a private CA, move that CA's certificate to `ca-cert` above; if a
> run did go out with it set, rotate the token.

When a handshake is refused the step reports the underlying reason rather than a
bare `fetch failed`, because the reason decides the fix:
`DEPTH_ZERO_SELF_SIGNED_CERT` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` means `ca-cert`
is missing or wrong, while `ERR_TLS_CERT_ALTNAME_INVALID` means the certificate
does not name the host you pointed at.

## Module provenance

With `include-module-provenance: true` (the default) the report carries two
extra fields, and both are **projections** — neither document is forwarded
verbatim, because the callback body is POSTed *and* written to a
world-readable temp file:

- **`plan`** — per top-level module call, only `source` and
  `version_constraint`. Every literal argument (`expressions[*].constant_value`,
  where a hardcoded password written in `.tf` would sit) and the recursive
  `module` subtree are dropped by construction.
- **`module_locks`** — per entry of `.terraform/modules/modules.json`, only
  `Key`, `Source` and `Version`. `Dir` (the runner-local checkout path) and any
  field Terraform adds later are dropped.

Every `Source`/`source` is scrubbed of the credentials a go-getter address can
embed — URL userinfo (`git::https://x-access-token:ghp_…@github.com/...`) and
credential-bearing query parameters (`sshkey=`, `X-Amz-Signature=`, `token=`;
only `ref` survives) — by the shared
[`@4cloudguru/terraform-drift-contract`](https://www.npmjs.com/package/@4cloudguru/terraform-drift-contract),
so both fields redact the same address identically. The TSM backend reads only
`Source` + `Version` from the locks and the two `module_calls` fields, so the
projection drops nothing a consumer uses.

The host-authorization primitives come from
[`@4cloudguru/pipeline-task-core`](https://www.npmjs.com/package/@4cloudguru/pipeline-task-core),
shared with the Azure Pipelines task extensions, so this action and they cannot
drift apart.

## Contract

The count/summary semantics match the TSM backend's `driftingest` package
exactly; the test fixtures are vendored from the backend so they cannot diverge.
See the repo README ("Contract").
