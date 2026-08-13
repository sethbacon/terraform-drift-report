import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { createHostAuthorizer } from '../src/egress'
import { describeError, postJson, resolveTlsTrust } from '../src/callback'

/**
 * The class test for TLS peer verification on the request that carries the
 * per-run callback token.
 *
 * Two tables. The first covers the withdrawn `reject-unauthorized: false`:
 * every spelling of "off" must fail the step, and only absence or an explicit
 * true may pass. The second runs REAL handshakes against a locally-generated
 * private CA, because the property at stake — that turning off verification
 * turned off hostname checking too — is a property of Node's TLS stack, not of
 * our own branching, and asserting it anywhere else would assert nothing.
 */

interface TrustRow {
  what: string
  rejectUnauthorized: string
  caCert?: string
  /** Absent means the inputs are accepted; present is the substring the refusal must carry. */
  reject?: string
  expectCaCert?: string
}

const TRUST_ROWS: TrustRow[] = [
  // --- the default: verification on, nothing to configure ---
  { what: "the action default 'true'", rejectUnauthorized: 'true' },
  { what: 'unset (an empty input)', rejectUnauthorized: '' },
  { what: "explicit 'True'", rejectUnauthorized: 'True' },
  { what: "explicit 'TRUE'", rejectUnauthorized: 'TRUE' },
  { what: "explicit '1'", rejectUnauthorized: '1' },
  { what: "explicit 'yes'", rejectUnauthorized: 'yes' },
  { what: 'a padded true', rejectUnauthorized: '  true  ' },
  { what: 'whitespace only', rejectUnauthorized: '   ' },

  // --- the fail-closed refusal, in every spelling an operator might reach for ---
  { what: "'false' fails the step", rejectUnauthorized: 'false', reject: "'ca-cert'" },
  { what: "'False' fails the step", rejectUnauthorized: 'False', reject: "'ca-cert'" },
  { what: "'FALSE' fails the step", rejectUnauthorized: 'FALSE', reject: "'ca-cert'" },
  { what: "'no' fails the step (not a YAML boolean, still refused)", rejectUnauthorized: 'no', reject: "'ca-cert'" },
  { what: "'0' fails the step", rejectUnauthorized: '0', reject: "'ca-cert'" },
  { what: 'a padded false fails the step', rejectUnauthorized: '  false  ', reject: "'ca-cert'" },
  // Fail-closed on a value we cannot read as "verification on": it is more
  // likely a typo'd attempt to switch verification off than a request to keep
  // the default, and quietly ignoring it would hide that the switch is gone.
  { what: 'an unreadable spelling fails the step rather than being ignored', rejectUnauthorized: 'flase', reject: "'ca-cert'" },
  {
    what: 'setting it false alongside a CA certificate still fails the step',
    rejectUnauthorized: 'false',
    caCert: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
    reject: "'ca-cert'",
  },

  // --- the supported private-CA path ---
  {
    what: 'a CA certificate is carried through as a trust anchor',
    rejectUnauthorized: 'true',
    caCert: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
    expectCaCert: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
  },
  { what: 'a blank CA certificate is not a trust anchor', rejectUnauthorized: 'true', caCert: '   ' },
]

describe('TLS trust resolved from the action inputs', () => {
  it.each(TRUST_ROWS)('$what', (row) => {
    if (row.reject) {
      expect(() => resolveTlsTrust(row.rejectUnauthorized, row.caCert ?? '')).toThrow(row.reject)
      return
    }
    expect(resolveTlsTrust(row.rejectUnauthorized, row.caCert ?? '')).toEqual(
      row.expectCaCert ? { caCert: row.expectCaCert } : {},
    )
  })

  it('names the credential exposure, not just the input, when it refuses', () => {
    expect(() => resolveTlsTrust('false', '')).toThrow(/hostname/i)
    expect(() => resolveTlsTrust('false', '')).toThrow(/callback token/i)
  })
})

/**
 * A TSM callback endpoint served over TLS by a certificate this machine's trust
 * store does not know — i.e. exactly the private-CA situation
 * `reject-unauthorized: false` existed for. The certificate names `localhost`
 * only, so reaching the same socket via `127.0.0.1` is a genuine hostname
 * mismatch.
 */
let dir: string
let server: https.Server
let port: number
let caPem: string
let otherCaPem: string

function generateSelfSigned(prefix: string): { cert: string; key: string } {
  const certPath = join(dir, `${prefix}-cert.pem`)
  const keyPath = join(dir, `${prefix}-key.pem`)
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' },
  )
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tdr-tls-'))
  const endpoint = generateSelfSigned('tsm')
  caPem = endpoint.cert
  otherCaPem = generateSelfSigned('unrelated').cert

  server = https.createServer({ cert: endpoint.cert, key: endpoint.key }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
}, 30_000)

afterAll(() => {
  server?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

interface HandshakeRow {
  what: string
  /** Host in the callback URL. `localhost` matches the certificate; `127.0.0.1` does not. */
  host: 'localhost' | '127.0.0.1'
  ca: 'tsm' | 'unrelated' | 'none'
  /** Absent means the request must succeed. */
  reject?: RegExp
}

const HANDSHAKE_ROWS: HandshakeRow[] = [
  {
    what: 'default (no trust anchor): a privately-issued certificate is refused',
    host: 'localhost',
    ca: 'none',
    reject: /self.signed|unable to verify|DEPTH_ZERO/i,
  },
  {
    what: 'the supported private-CA path: the endpoint CA is trusted and the callback succeeds',
    host: 'localhost',
    ca: 'tsm',
  },
  {
    // The row that was the vulnerability: under reject-unauthorized: false this
    // exact request succeeded and handed over the callback token. Trusting the
    // CA does NOT buy back hostname verification, so it is still refused.
    what: 'hostname mismatch is refused even with the CA trusted',
    host: '127.0.0.1',
    ca: 'tsm',
    reject: /ALTNAME|does not match/i,
  },
  {
    what: 'hostname mismatch with no trust anchor is refused',
    host: '127.0.0.1',
    ca: 'none',
    reject: /self.signed|unable to verify|ALTNAME|DEPTH_ZERO/i,
  },
  {
    what: 'an unrelated CA does not vouch for this endpoint',
    host: 'localhost',
    ca: 'unrelated',
    reject: /self.signed|unable to verify|DEPTH_ZERO/i,
  },
]

describe('TLS failures are reported with the reason, not just "fetch failed"', () => {
  it('unwraps the cause chain that carries the TLS diagnosis', () => {
    const cause = Object.assign(new Error('self-signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    })
    expect(describeError(Object.assign(new Error('fetch failed'), { cause }))).toBe(
      'fetch failed: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)',
    )
  })

  it('passes an ordinary error through unchanged', () => {
    expect(describeError(new Error('plan-json-file does not exist: plan.json'))).toBe(
      'plan-json-file does not exist: plan.json',
    )
  })

  it('handles a thrown non-error', () => {
    expect(describeError('boom')).toBe('boom')
  })
})

describe('TLS verification on the credentialed drift callback (real handshakes)', () => {
  it.each(HANDSHAKE_ROWS)('$what', async (row) => {
    const caCert = row.ca === 'tsm' ? caPem : row.ca === 'unrelated' ? otherCaPem : undefined
    // The endpoint is on loopback, so it is reachable only because the operator
    // pinned it — the egress control and the TLS control compose rather than
    // one standing in for the other.
    const request = postJson(
      `https://${row.host}:${port}/api/v1/drift/ingest`,
      { 'X-TSM-Callback-Token': 'secret' },
      '{"status":"completed"}',
      createHostAuthorizer('localhost,127.0.0.1'),
      { caCert },
    )
    if (row.reject) {
      const error = await request.then(
        () => null,
        (e: unknown) => e,
      )
      expect(error, 'the handshake was accepted when it had to be refused').not.toBeNull()
      expect(describeError(error)).toMatch(row.reject)
    } else {
      await expect(request).resolves.toEqual({ status: 200, body: '{"ok":true}' })
    }
  }, 30_000)

  /**
   * A re-runnable signature rather than a list assembled by reading: any future
   * reintroduction of a verification-off switch anywhere in `src` reddens this,
   * including the env-var spelling that never touches our own client options.
   */
  it('leaves no way to disable peer verification anywhere in src', () => {
    // vitest runs from the project root.
    const srcDir = join(process.cwd(), 'src')
    const offending = readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => {
        const text = readFileSync(join(srcDir, f), 'utf8')
        return /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity\s*:/.test(text)
          ? [f]
          : []
      })
    expect(offending).toEqual([])
  })
})
