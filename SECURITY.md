# Security

This action reads a Terraform/OpenTofu plan JSON and emits drift counts, a
changed-resource summary, a JSON artifact and (optionally) a POST to a Terraform
State Manager (TSM) callback. **Plan JSON contains unredacted secrets** —
`terraform show -json` prints values declared `sensitive = true` in cleartext;
only the human-readable console format masks them. Everything this action emits
is therefore derived from a secret-bearing input, and the redaction behaviour
below is a security control rather than a formatting detail.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use [GitHub's private vulnerability reporting](https://github.com/sethbacon/terraform-drift-report/security/advisories/new)
instead. This keeps the report confidential until a fix is available.

When reporting, please include a description of the impact, the affected
version(s) or commit range, and a plan fragment (with real secrets replaced)
that reproduces it. You can expect an acknowledgement within a few business
days.

If the issue is in the redaction of the drift summary itself rather than in this
action's own code, report it against
[`@4cloudguru/terraform-drift-contract`](https://github.com/4cloudguru/terraform-drift-contract/security/advisories/new)
— see below.

## Supported Versions

Only the latest published release receives security fixes. If you are pinned to
an older tag or a commit SHA, that pin does not receive them until you move it.

## Redaction is owned by the contract package, not by this action

The counts, the `summary[]` entries and the module-provenance block are produced
by [`@4cloudguru/terraform-drift-contract`](https://www.npmjs.com/package/@4cloudguru/terraform-drift-contract),
the shared implementation this action, the Azure DevOps `TerraformDriftReport`
task and the TSM backend all reconcile against. This action passes the parsed
plan in and emits what comes back — it adds no masking of its own and removes
none.

**[That package's `SECURITY.md`](https://github.com/4cloudguru/terraform-drift-contract/blob/main/SECURITY.md)
is the authority on what is and is not redacted**, including the guarantees, the
non-guarantees and the known divergences from the Go/Python/jq implementations
of the same contract. It is not restated here, because a second copy is a copy
that goes stale. Two consequences are worth stating in this repository, though,
because they are what an operator of *this action* sees:

- **A value marked sensitive on either side of a change is masked on both.**
  Since contract v1.1.0, `attrs[].before` / `attrs[].after` are emitted as the
  literal `"(sensitive)"` when **either** `before_sensitive` or `after_sensitive`
  marks the key. This matters in practice because terraform applies a
  config-derived mark (a `sensitive = true` variable, `sensitive()`, a sensitive
  module output) to the *planned* value only and never persists it to state, so a
  credential routinely arrives marked on exactly one side. Releases of this
  action built against contract v1.0.0 masked each side against its own mirror
  and therefore emitted the unmarked side verbatim.
- **`summary[].address` is emitted verbatim, and is not truncated.** A resource
  address derived from a secret — a `for_each` or `count` key such as
  `aws_secretsmanager_secret.this["<the secret value>"]` — reaches the outputs,
  the JSON artifact and the callback body in cleartext. This is a known,
  deliberately unfixed residual in *every* implementation of the contract: the
  address is the summary's primary key, so masking it would break drift-record
  identity. Do not build resource addresses out of secret values.

## What this action is responsible for

Everything downstream of the returned object is this repository's problem, not
the contract package's:

- **The JSON artifact is written to the runner's temp directory at a fixed
  path** (`<os.tmpdir()>/tsm-drift-report.json`) with default file permissions,
  and its path is published as the `summary-file` output. It holds the exact
  callback body, including any unmasked attribute values the plan did not mark
  sensitive. On a GitHub-hosted runner the VM is ephemeral and single-tenant, so
  this is bounded; **on a self-hosted runner it is not** — the file is readable
  by other processes on the machine and survives the step. Treat a self-hosted
  runner's temp directory as in-scope, and do not upload the file as a
  workflow artifact unless the audience for that artifact is the audience for
  the plan.
- **The step summary and job log.** The action logs only counts, never attribute
  values. The `callback-token` is registered with `core.setSecret()` as soon as
  it is read, so it is masked in the log whether or not the callback is made.
- **Callback egress.** `callback-url` must be `https://`, and the destination
  host is authorized before the request is issued and again on every redirect
  hop, because a hop re-sends the same bearer token. With
  `callback-allowed-hosts` unset, reserved/private/link-local destinations
  (including `169.254.169.254`) are refused; with it set, only the listed hosts
  are permitted on any hop. See the README's [Callback egress](README.md#callback-egress)
  section for the exact matching rules. This bounds where the drift body can be
  sent; it does not change what the body contains.

## Supply chain

The contract dependency is the published npm package
`@4cloudguru/terraform-drift-contract`, not a git tag, so a security fix in it
reaches this action through an ordinary Dependabot bump rather than a manual pin
move. It is published with npm provenance from a trusted-publishing workflow;
`npm audit signatures` verifies the attestation.

This action ships a committed, esbuild-bundled `dist/index.js` — that bundle, not
`src/`, is what runs. CI rebuilds it on every PR and fails if the committed
bundle differs, so a dependency upgrade that never reached `dist/` cannot merge.

## Preferred Languages

English preferred.

## Shared CI workflows

Part of this repository's CI is **defined in another repository** — [`4cloudguru/shared-workflows`](https://github.com/4cloudguru/shared-workflows) — and called from `.github/workflows/`. That is a real supply-chain relationship, and it is recorded here so an audit of this repository does not stop at this repository's own tree.

**What runs, and where it is pinned.** Each caller in `.github/workflows/` names the shared workflow on its `uses:` line, pinned to a full 40-hex commit SHA with a trailing comment naming the release that SHA is. The tag is a label; the SHA is what runs. An unlabelled SHA is rejected by the workflow-hardening gate, because a bare 40-hex ref cannot be reviewed or updated deliberately.

**Why the pins have to agree across repositories.** A shared definition drifts differently from a duplicated file: every repository looks like it is using "the shared one" while sitting on different commits, which is *harder* to see than divergent files, not easier. A signature in `security-orchestration` (`shared-workflow-pin-parity`) reports **disagreement** between callers of the same shared workflow — it reports disagreement rather than staleness, because a repository deliberately held back is a decision while N repositories disagreeing without anyone deciding is drift.

**What the shared repository is itself protected by.** Its `main` requires its own zizmor and actionlint checks with `enforce_admins` enabled, restricts which third-party actions may run to an explicit allowlist, issues a read-only default `GITHUB_TOKEN`, and runs the workflow-hardening gate against itself.

**What this repository still controls.** Triggers, concurrency, and the secrets it passes. Secrets are passed **by name** — never `secrets: inherit`, which would forward every secret in this repository to a workflow owned by someone else. Any `vars.*` a shared workflow reads resolve against **this** repository, so credentials and their installation scope do not move.
