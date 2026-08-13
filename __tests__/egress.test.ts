import { describe, expect, it } from 'vitest'
import { postJson } from '../src/callback'
import { createHostAuthorizer, type Lookup } from '../src/egress'

/**
 * The egress-authorization class test for the credentialed drift callback.
 *
 * Every row is a destination the `callback-token` bearer would be handed to.
 * The rows are deliberately spelled in the forms that defeat a TEXTUAL
 * dotted-quad blocklist — short-form, decimal, hex, octal, IPv4-mapped IPv6 —
 * plus the ranges such a blocklist omits outright (RFC 6598 carrier-grade NAT),
 * plus the redirect hop that a check applied only to the initial URL misses.
 */

/** Resolves everything to a public address, so a name-only row never touches real DNS. */
const publicDns: Lookup = async () => [{ address: '203.0.113.10' }]

/** Resolves everything to the cloud instance-metadata address. */
const metadataDns: Lookup = async () => [{ address: '169.254.169.254' }]

interface HostRow {
  what: string
  host: string
  allowedHosts?: string
  lookup?: Lookup
  /** Substring the rejection must contain; absent means the host must be permitted. */
  reject?: string
}

const HOST_ROWS: HostRow[] = [
  // --- default deny: literal spellings of loopback that a textual blocklist misses ---
  { what: 'dotted-quad loopback', host: '127.0.0.1', reject: 'private' },
  { what: 'short-form loopback (127.1)', host: '127.1', reject: 'private' },
  { what: 'decimal loopback (2130706433)', host: '2130706433', reject: 'private' },
  { what: 'hex loopback (0x7f000001)', host: '0x7f000001', reject: 'private' },
  { what: 'octal loopback (017700000001)', host: '017700000001', reject: 'private' },
  { what: 'IPv4-mapped IPv6 loopback', host: '[::ffff:127.0.0.1]', reject: 'private' },
  { what: 'IPv6 loopback', host: '[::1]', reject: 'private' },
  { what: 'the name localhost', host: 'localhost', reject: 'private' },

  // --- default deny: ranges beyond loopback ---
  { what: 'cloud instance-metadata address', host: '169.254.169.254', reject: 'private' },
  { what: 'CGNAT 100.64.0.0/10 (RFC 6598)', host: '100.64.1.1', reject: 'private' },
  { what: 'CGNAT upper bound 100.127.255.255', host: '100.127.255.255', reject: 'private' },
  { what: 'RFC1918 10.0.0.0/8', host: '10.0.0.5', reject: 'private' },
  { what: 'RFC1918 172.16.0.0/12', host: '172.16.0.1', reject: 'private' },
  { what: 'RFC1918 192.168.0.0/16', host: '192.168.1.1', reject: 'private' },
  { what: 'IPv6 link-local', host: '[fe80::1]', reject: 'private' },
  { what: 'IPv6 unique-local', host: '[fd00::1]', reject: 'private' },
  { what: 'private address carrying an explicit port', host: '10.0.0.5:8443', reject: 'private' },
  { what: 'a name that RESOLVES to the metadata address', host: 'tsm.example.com', lookup: metadataDns, reject: 'private' },

  // --- default deny: the legitimate destinations that must keep working ---
  { what: 'a public TSM callback host', host: 'tsm.example.com', lookup: publicDns },
  { what: 'a public host carrying an explicit port', host: 'tsm.example.com:8443', lookup: publicDns },
  { what: 'a public IP literal (no DNS lookup needed)', host: '203.0.113.10' },

  // --- allowlist: the operator pins their own hosts, enforced instead of the range check ---
  { what: 'a pinned, deliberately-private self-hosted endpoint', host: '10.0.0.5', allowedHosts: '10.0.0.5' },
  { what: 'a pinned private host named by DNS', host: 'tsm.internal', allowedHosts: 'tsm.internal' },
  { what: 'a wildcard pin matching exactly one label', host: 'drift.tsm.example.com', allowedHosts: '*.tsm.example.com' },
  { what: 'a public host outside the pin', host: 'evil.example.com', allowedHosts: '*.tsm.example.com', reject: 'not in callback-allowed-hosts' },
  { what: 'the metadata address outside the pin', host: '169.254.169.254', allowedHosts: 'tsm.example.com', reject: 'not in callback-allowed-hosts' },
  { what: 'a wildcard pin does NOT span two labels', host: 'a.drift.tsm.example.com', allowedHosts: '*.tsm.example.com', reject: 'not in callback-allowed-hosts' },
  // Redirect hops are authorized on `URL.host`, which carries an explicit port,
  // so a pin cannot silently match a hop to a DIFFERENT port on an allowlisted
  // host. The initial URL is authorized on `.hostname`, so an operator's own
  // `https://tsm.example.com:8443/` endpoint is unaffected; only a redirect
  // onto a non-default port is refused, which is fail-closed and deliberate.
  { what: 'a pin does not cover a redirect hop onto another port', host: 'tsm.example.com:8443', allowedHosts: 'tsm.example.com', reject: 'not in callback-allowed-hosts' },
]

describe('callback egress authorization', () => {
  it.each(HOST_ROWS)('$what', async (row) => {
    const authorize = createHostAuthorizer(row.allowedHosts ?? '', row.lookup ?? publicDns)
    if (row.reject) {
      await expect(authorize(row.host)).rejects.toThrow(row.reject)
    } else {
      await expect(authorize(row.host)).resolves.toBeUndefined()
    }
  })

  it.each([
    ['*.com', 'a wildcard spanning a public suffix'],
    ['example.com*', 'a pin that would silently match nothing'],
    ['tsm.example.com:8443', 'a pin carrying a port'],
  ])('refuses the allowlist entry %s (%s)', (entry) => {
    expect(() => createHostAuthorizer(entry)).toThrow('Invalid allowed-hosts entry')
  })
})

/** Records every URL the transport actually reached, so a refused hop is provably not contacted. */
function recordingFetch(responses: Array<() => Response>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const next = responses[urls.length - 1]
    if (!next) throw new Error(`unexpected request to ${String(input)}`)
    return next()
  }) as typeof fetch
  return { fetch: impl, urls }
}

const ok = (): Response => new Response('{"ok":true}', { status: 200 })
const redirectTo = (location: string) => (): Response =>
  new Response(null, { status: 302, headers: { location } })

describe('callback transport authorizes the initial URL and every redirect hop', () => {
  const post = (url: string, allowedHosts: string, fetchImpl: typeof fetch) =>
    postJson(
      url,
      { 'X-TSM-Callback-Token': 'secret' },
      '{}',
      true,
      createHostAuthorizer(allowedHosts, publicDns),
      fetchImpl,
    )

  it('refuses a private initial URL without issuing the request', async () => {
    const { fetch: impl, urls } = recordingFetch([ok])
    await expect(post('https://169.254.169.254/drift', '', impl)).rejects.toThrow('private')
    expect(urls).toEqual([])
  })

  it('refuses a redirect hop onto a private host after the first request', async () => {
    const { fetch: impl, urls } = recordingFetch([redirectTo('https://169.254.169.254/steal'), ok])
    await expect(post('https://tsm.example.com/drift', '', impl)).rejects.toThrow('private')
    // Exactly one request: the hop was refused BEFORE the credentialed retry
    // reached the metadata service. A per-hop check that is not awaited leaves
    // the second entry here.
    expect(urls).toEqual(['https://tsm.example.com/drift'])
  })

  it('refuses a redirect hop outside the operator allowlist', async () => {
    const { fetch: impl, urls } = recordingFetch([redirectTo('https://evil.example.com/steal'), ok])
    await expect(post('https://tsm.example.com/drift', 'tsm.example.com', impl)).rejects.toThrow(
      'not in callback-allowed-hosts',
    )
    expect(urls).toEqual(['https://tsm.example.com/drift'])
  })

  it('follows a redirect hop that is itself authorized', async () => {
    const { fetch: impl, urls } = recordingFetch([redirectTo('https://drift.tsm.example.com/v2'), ok])
    await expect(post('https://tsm.example.com/drift', '*.tsm.example.com, tsm.example.com', impl)).resolves.toEqual({
      status: 200,
      body: '{"ok":true}',
    })
    expect(urls).toEqual(['https://tsm.example.com/drift', 'https://drift.tsm.example.com/v2'])
  })

  it('posts to a public callback host unchanged', async () => {
    const { fetch: impl, urls } = recordingFetch([ok])
    await expect(post('https://tsm.example.com/drift', '', impl)).resolves.toEqual({
      status: 200,
      body: '{"ok":true}',
    })
    expect(urls).toEqual(['https://tsm.example.com/drift'])
  })

  it('refuses a non-https callback URL', async () => {
    const { fetch: impl, urls } = recordingFetch([ok])
    await expect(post('http://tsm.example.com/drift', '', impl)).rejects.toThrow('https')
    expect(urls).toEqual([])
  })
})
