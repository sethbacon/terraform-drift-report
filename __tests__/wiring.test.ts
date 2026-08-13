import { describe, it, expect } from 'vitest'
import { summarize, moduleCallsPlan } from '@4cloudguru/terraform-drift-contract'

// The action's parsing logic is owned and exhaustively tested by
// @4cloudguru/terraform-drift-contract. This proves the dependency resolves and
// is wired in; the contract package's own suite covers the semantics.
describe('drift-report wiring', () => {
  it('consumes the shared contract', () => {
    const r = summarize({ resource_changes: [{ address: 'x', change: { actions: ['create'], before: null, after: { k: 1 } } }] })
    expect([r.added, r.changed, r.destroyed, r.drifted]).toEqual([1, 0, 0, true])
    expect(r.summary[0].address).toBe('x')
  })
})

// The published package's >=1.1.0 redaction behaviour, asserted through the real
// dependency rather than a stub. These are the two changes the action inherited
// by moving off the git pin at v1.0.0; if the resolved package ever regressed to
// the old per-side masking or the raw config passthrough, these fail here — in
// the consumer that actually emits the payload.
describe('drift-report inherits the contract redaction fixes', () => {
  it('masks both sides when only one sensitivity mirror marks the key', () => {
    const r = summarize({
      resource_changes: [
        {
          address: 'aws_instance.web',
          change: {
            actions: ['update'],
            before: { user_data: 'old-plaintext-secret' },
            after: { user_data: 'new-plaintext-secret' },
            // Terraform applies a config-derived sensitivity mark to the PLANNED
            // value only; it is never persisted to state, so a credential
            // routinely arrives marked on exactly one side.
            before_sensitive: {},
            after_sensitive: { user_data: true },
          },
        },
      ],
    })

    const attrs = r.summary[0].attrs
    expect(attrs).toEqual([{ name: 'user_data', before: '(sensitive)', after: '(sensitive)' }])
    // Belt and braces: neither literal may appear anywhere in the emitted payload.
    const emitted = JSON.stringify(r)
    expect(emitted).not.toContain('old-plaintext-secret')
    expect(emitted).not.toContain('new-plaintext-secret')
  })

  it('projects module provenance instead of forwarding the raw config subtree', () => {
    const plan = {
      configuration: {
        root_module: {
          module_calls: {
            vpc: {
              source: 'git::https://x-access-token:ghp_realtokenvalue@github.com/org/mod.git',
              version_constraint: '~> 5.0',
              expressions: { db_password: { constant_value: 'hunter2-in-the-config' } },
              module: { resources: [{ address: 'aws_db_instance.this' }] },
            },
          },
        },
      },
    }

    const emitted = JSON.stringify(moduleCallsPlan(plan))
    expect(emitted).not.toContain('hunter2-in-the-config')
    expect(emitted).not.toContain('ghp_realtokenvalue')
    expect(emitted).not.toContain('aws_db_instance.this')
    expect(JSON.parse(emitted)).toEqual({
      configuration: {
        root_module: {
          module_calls: {
            vpc: {
              source: 'git::https://(redacted)@github.com/org/mod.git',
              version_constraint: '~> 5.0',
            },
          },
        },
      },
    })
  })
})
