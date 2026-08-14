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
| `commit-sha` | `""` → `GITHUB_SHA` | commit the plan was computed from, sent as `commit_sha` (see [Report provenance](#report-provenance)) |
| `callback-url` | `""` | TSM callback URL; POST happens only with both url + token |
| `callback-token` | `""` | per-run one-shot token (sent as `X-TSM-Callback-Token`) |
| `ca-cert` | `""` | PEM CA certificate for a callback endpoint behind a private CA (see [Private CAs](#private-cas)) |
| `reject-unauthorized` | `true` | **a false value now fails the step** (see [Private CAs](#private-cas)) |
| `callback-allowed-hosts` | `""` | hosts the callback may be sent to (see [Callback egress](#callback-egress)) |

## Outputs

| Output | Notes |
|--------|-------|
| `drifted` | the **string** `"true"` or `"false"` — see the note below |
| `added` / `changed` / `destroyed` | resource counts (replacement counts as add **and** destroy) |
| `summary-file` | path to the JSON report (the exact callback body) |

> **`drifted` is a string, and `if:` treats every non-empty string as true.**
> `if: steps.drift.outputs.drifted` runs the step even when the value is the
> literal `"false"`, because GitHub Actions has no boolean output type. Compare
> explicitly:
>
> ```yaml
> - if: steps.drift.outputs.drifted == 'true'
>   run: echo "drift!"
> ```

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
  **The body key is `plan`, not `module_calls`**: the calls sit at
  `plan.configuration.root_module.module_calls`. Anything reading `summary-file`
  or the callback body should look there.
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

## Report provenance

The callback body carries **`commit_sha`**: the commit the plan was computed
from. It defaults to the runner's `GITHUB_SHA`, so a report is bound to a tree
without the workflow setting anything; `commit-sha` overrides it when the plan
genuinely comes from a different commit.

This matters because drift reports are consumed as a **time series**, which is
the point of the callback. Without a commit, two reports for the same state are
ordered only by arrival time — so a re-run against an older commit lands after a
newer one and reads as the current state, no report can be re-derived or audited
against the tree it describes, and "drift appeared between X and Y" is not
answerable.

The field is **omitted rather than sent empty** when there is no commit to
report, so a receiver can distinguish "this runner had none" from "an older
version of this action that never sent one". Both are backward-compatible: the
TSM endpoints decode with unknown keys ignored, so an older backend accepts the
new key without error.

> **What the receiver does with it is a separate question.** As of this writing
> neither TSM drift endpoint declares a commit field and the `drift_records`
> table has no column for one, so `commit_sha` is currently accepted and
> dropped. Persisting it needs a backend change; sending it is the half that has
> to come first, and the sibling
> [`terraform-module-publish`](https://github.com/sethbacon/terraform-module-publish)
> binds its published versions the same way. Do **not** repurpose TSM's
> `external_ref` for this — it carries a unique index for retry idempotency and
> would collide across states sharing a commit.

## Contract

The count/summary semantics are defined by
[`@4cloudguru/terraform-drift-contract`](https://github.com/4cloudguru/terraform-drift-contract)
and mirrored by the TSM backend's Go `driftingest` package. That package's
[README, "Contract" section](https://github.com/4cloudguru/terraform-drift-contract#contract)
is the authority — including its statement that parity with the Go and jq
mirrors is checked **by hand**, with no shared fixture set and no conformance
run. (An earlier revision of this section said "see the repo README", which read
as a self-reference; it meant the dependency's README, and said so nowhere.)

## What ends up in the report, and where it goes

Worth stating plainly, because the docs above describe the mechanics and not the
consequences:

- **Changed attribute values are forwarded in cleartext unless Terraform marked
  them sensitive.** Redaction follows the plan's `before_sensitive` /
  `after_sensitive` maps and nothing else, so attributes providers routinely
  leave unmarked — EC2 `user_data`, container `env` blocks, ConfigMap and tag
  values, connection strings — are emitted, up to 300 code points each, for
  every in-place update or replacement. A plan carrying neither sensitivity map
  gets no masking at all. Treat the callback endpoint as a recipient of that
  data.
- **The report file is the exact callback body.** It is written under
  `$RUNNER_TEMP` in a `mkdtemp` directory with mode `0600` and removed by the
  action's `post:` step, so it does not outlive the job — but its path is
  published as the `summary-file` output, and any later step in the same job can
  read it.
- **`callback-url` receives the token wherever it points.** The egress guard
  above refuses private, link-local and reserved destinations by default, and
  `callback-allowed-hosts` is how you narrow it further. Credentials embedded in
  the URL (`https://user:pass@host/`) are **refused**, not silently dropped:
  `fetch` never sends them, so accepting them would mean discarding an
  operator's credential without a word. Authenticate with `callback-token`.
- **`plan-json-file` is read with two guards.** A symlink whose target escapes
  both `GITHUB_WORKSPACE` and `RUNNER_TEMP` is refused — on a fork PR the
  checkout is attacker-influenced, and following such a link would put an
  unrelated file into the report and the POST body — and a plan above 256 MiB is
  refused rather than parsed and serialised twice in memory.

## Pinning this action

The examples above use `@v1` for readability. **`v1` is a mutable tag** — this
repository's maintainers move it to each new `v1.x`, so what your workflow
executes changes without any diff on your side. That is a convenience, and it is
a trust decision you are making about this repository. What you actually run is
a ~500 KB minified, sourcemap-free `ncc` bundle, so a substitution is not
something anyone will catch by reading a diff.

For supply-chain-sensitive workflows, pin the full commit SHA instead:

```yaml
- uses: sethbacon/terraform-drift-report@<full-40-char-sha> # v1.0.1
  with:
    plan-json: plan.json
```

The trailing comment is what makes the pin maintainable — Dependabot reads it,
and so does the next human. The tradeoff is the mirror image of `@v1`: a SHA pin
never changes under you, and it never picks up a fix either, so it needs
updating deliberately.

Releases are cut by [`release.yml`](.github/workflows/release.yml), which
against the tagged tree re-runs lint, tests, `npm audit` and — the point of the
tag trigger — **the dist-sync check**, proving the committed bundle is the one a
build of that ref produces. It refuses a tag not reachable from `main`, emits a
[build-provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations)
over `dist/index.js` plus a CycloneDX SBOM, and only then moves the `v1` alias.
Verify a release with:

```bash
gh attestation verify --owner sethbacon --repo terraform-drift-report dist/index.js
```
