/**
 * SCOPE — the callback's resource and log boundaries.
 *
 * DOES claim: a response body is bounded regardless of what the peer sends;
 * the bound is the shared client's, not a local reimplementation; the status is
 * still returned to the caller for a non-2xx, because the action formats its
 * own message from it; and remote-controlled text is stripped and truncated
 * before it can reach a failure annotation.
 *
 * Does NOT claim: that the callback host is authorized (that is egress.test.ts)
 * nor that TLS is verified (tls.test.ts) — both are exercised elsewhere and are
 * deliberately not re-asserted here.
 */
import { describe, it, expect } from 'vitest'
import { MAX_RESPONSE_BYTES, truncateForLog } from '@4cloudguru/pipeline-task-core'
import { postJson } from '../src/callback'

const allowAll = async (): Promise<void> => undefined

/** A fetch double answering with a body of the requested size. */
function respondingWith(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch
}

describe('drift callback — response bodies are bounded', () => {
  /**
   * The regression this locks down: postJson used to pass its own
   * `async (r) => ({ status: r.status, body: await r.text() })` to
   * fetchWithTimeout. A caller-supplied consume owns the body and never reaches
   * the shared client's readBounded, so maxResponseBytes silently did not apply
   * — measured at 52,428,800 bytes buffered against a 1,024-byte cap.
   */
  it('refuses a body larger than the shared client cap', async () => {
    const oversize = 'x'.repeat(MAX_RESPONSE_BYTES + 1024)
    await expect(
      postJson(
        'https://tsm.example/cb',
        {},
        '{}',
        allowAll,
        { fetchImpl: respondingWith(oversize) },
      ),
    ).rejects.toThrow(/exceeded \d+ bytes/)
  })

  it('accepts a body under the cap', async () => {
    const res = await postJson(
      'https://tsm.example/cb',
      {},
      '{}',
      allowAll,
      { fetchImpl: respondingWith('{"ok":true}') },
    )
    expect(res).toEqual({ status: 200, body: '{"ok":true}' })
  })

  /**
   * The action formats its own failure message from the status, so the
   * accessor must hand back a non-2xx rather than throwing — otherwise the
   * bounded read would have come at the cost of the diagnostic.
   */
  it.each([400, 401, 404, 500, 503])('returns status %i with its body instead of throwing', async (status) => {
    const res = await postJson(
      'https://tsm.example/cb',
      {},
      '{}',
      allowAll,
      { fetchImpl: respondingWith('rejected', status) },
    )
    expect(res).toEqual({ status, body: 'rejected' })
  })

  it('bounds an oversize body even on an error status', async () => {
    await expect(
      postJson(
        'https://tsm.example/cb',
        {},
        '{}',
        allowAll,
        { fetchImpl: respondingWith('e'.repeat(MAX_RESPONSE_BYTES + 1), 500) },
      ),
    ).rejects.toThrow(/exceeded \d+ bytes/)
  })
})

describe('drift callback — remote text reaching the failure annotation', () => {
  // core.setFailed percent-encodes only %, CR and LF, so length and every other
  // control character were the peer's choice. These are the shapes a hostile or
  // merely broken endpoint would return.
  const CTRL = (code: number): string => String.fromCharCode(code)
  const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]')

  it.each([
    ['a 5 MB body', 'y'.repeat(5 * 1024 * 1024)],
    ['a forged workflow command', `ok${CTRL(10)}::error::forged${CTRL(10)}::set-output name=x::y`],
    ['NUL bytes', `before${CTRL(0)}after`],
    ['a bare carriage return', `line1${CTRL(13)}line2`],
    ['an escape sequence', `${CTRL(27)}[31mred${CTRL(27)}[0m`],
  ])('%s is truncated and stripped before it can be surfaced', (_label, body) => {
    const out = truncateForLog(body, 256)
    expect(out.length).toBeLessThanOrEqual(256 + 64)
    expect(CONTROL_CHARS.test(out)).toBe(false)
  })

  it('says how much was dropped rather than truncating silently', () => {
    expect(truncateForLog('z'.repeat(1000), 256)).toContain('more characters truncated')
  })

  it('leaves a short, clean body intact so the diagnostic still works', () => {
    expect(truncateForLog('{"error":"version already exists"}', 256)).toBe(
      '{"error":"version already exists"}',
    )
  })
})
