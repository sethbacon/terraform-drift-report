import { describe, it, expect } from 'vitest'
import { summarize } from 'terraform-drift-contract'

// The action's parsing logic is owned and exhaustively tested by
// terraform-drift-contract. This proves the dependency resolves and is wired in;
// the contract package's own suite covers the semantics.
describe('drift-report wiring', () => {
  it('consumes the shared contract', () => {
    const r = summarize({ resource_changes: [{ address: 'x', change: { actions: ['create'], before: null, after: { k: 1 } } }] })
    expect([r.added, r.changed, r.destroyed, r.drifted]).toEqual([1, 0, 0, true])
    expect(r.summary[0].address).toBe('x')
  })
})
