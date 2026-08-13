import { HttpError, METADATA_TIMEOUT_MS, createHttpClient } from '@4cloudguru/pipeline-task-core'
import { Agent } from 'undici'
import { URL } from 'url'
import type { AuthorizeHost } from './egress'

export interface HttpResponse {
  status: number
  body: string
}

/** Optional per-run tuning for {@link postJson}. */
export interface HttpsClientOptions {
  /**
   * PEM trust anchor(s) for a callback endpoint fronted by a private CA.
   * Supplying one REPLACES the default trust store for this client's requests,
   * which is the tighter choice: a publicly-trusted CA cannot then mint a
   * certificate for an internal TSM name and be believed.
   */
  caCert?: string
  /** `fetch` implementation, injectable so tests need no network. */
  fetchImpl?: typeof fetch
}

/** Refusal text for the withdrawn `reject-unauthorized: false`; names the replacement. */
export const REJECT_UNAUTHORIZED_REMOVED =
  "The 'reject-unauthorized' input no longer accepts a false value because it disabled certificate AND " +
  'hostname verification on the very request that carries the per-run callback token as a bearer ' +
  'credential, so any host that answered for the callback name harvested it — along with the full plan ' +
  "report. For a callback endpoint fronted by a private CA, supply that CA's certificate (PEM) as the " +
  "'ca-cert' input instead — verification stays on and the private CA is trusted. Remove " +
  "'reject-unauthorized' from the step."

/**
 * Turns the action's TLS inputs into the client's trust configuration, refusing
 * the withdrawn verification-off switch.
 *
 * Read as raw text rather than through `getBooleanInput` so that every spelling
 * an operator might reach for (`false`, `False`, `no`, `0`) hits the explanatory
 * refusal instead of a schema `TypeError` that says nothing about why. Only an
 * absent or explicitly-true value is treated as "not requested"; anything else
 * fails the step rather than being quietly ignored.
 */
export function resolveTlsTrust(rawRejectUnauthorized: string, rawCaCert: string): HttpsClientOptions {
  const verify = rawRejectUnauthorized.trim().toLowerCase()
  if (verify !== '' && verify !== 'true' && verify !== '1' && verify !== 'yes') {
    throw new Error(REJECT_UNAUTHORIZED_REMOVED)
  }
  const caCert = rawCaCert.trim()
  return caCert ? { caCert } : {}
}

/**
 * Flattens an error and its `cause` chain into a single line.
 *
 * `fetch` reports a refused handshake as a bare "fetch failed" and keeps the
 * reason one level down, so the unflattened message tells an operator nothing.
 * Which reason it is decides what they do next: an untrusted private CA
 * (`DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) means
 * `ca-cert` is missing or wrong, while a hostname mismatch
 * (`ERR_TLS_CERT_ALTNAME_INVALID`) means the certificate does not name the host
 * they pointed at.
 */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const { code } = current as NodeJS.ErrnoException
    parts.push(code ? `${current.message} (${code})` : current.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length > 0 ? parts.join(': ') : String(error)
}

/**
 * HTTPS POST built on the shared `@4cloudguru/pipeline-task-core` client rather
 * than a local copy of it. The hand-copied `https.request` helper this replaces
 * was ported from the ADO module-publish task, so it never received that
 * family's egress hardening; consuming the shared client means the next fix
 * arrives by version bump instead of by transcription.
 *
 * The client pins https, follows redirects manually, and re-runs
 * `authorizeHost` on the initial host AND on every hop — the request re-sends
 * the `callback-token` bearer to each one, so a hop is exactly as sensitive as
 * the first destination.
 *
 * TLS peer verification is not optional here and there is deliberately no
 * switch to turn it off: the request carries the per-run callback token, so an
 * unverified peer is a peer that harvests it. A private CA is accommodated by
 * ADDING its certificate as a trust anchor (`caCert`), which keeps both chain
 * and hostname verification — the two checks that the withdrawn
 * verification-off switch dropped together.
 */
export function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  authorizeHost: AuthorizeHost,
  options: HttpsClientOptions = {},
): Promise<HttpResponse> {
  const { caCert, fetchImpl } = options
  // One dispatcher per call, built only when the operator supplied a trust
  // anchor; Node's fetch has no other way to reach that socket option.
  const dispatcher = caCert ? new Agent({ connect: { ca: caCert } }) : undefined

  const client = createHttpClient({
    fetchImpl,
    fetchOptions: () => {
      const init: RequestInit = {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
      }
      if (dispatcher) {
        ;(init as RequestInit & { dispatcher: unknown }).dispatcher = dispatcher
      }
      return init
    },
    // `next.host`, not `next.hostname`, so an explicit port travels with the
    // host and an allowlist entry without one cannot silently match a redirect
    // to a different port. Awaited: an async rejection that is not awaited
    // cannot stop the in-flight request.
    // The refusal is re-thrown NON-retryable. fetchStatusText retries, and the
    // shared client classifies any non-HttpError as a transient transport
    // failure — so a plain throw here would be REPEATED, giving a host that
    // resolves differently per lookup several chances inside one run to flip
    // from refused to allowed. The library's own downloadToFile wraps its
    // authorizeHost refusal for exactly this reason.
    redirectPolicy: async (_originHost, next) => {
      try {
        await authorizeHost(next.host)
      } catch (error) {
        throw new HttpError(error instanceof Error ? error.message : String(error), false)
      }
      return true
    },
  })

  return (async () => {
    // Outside the retrying accessor, so this refusal is already fatal.
    await authorizeHost(new URL(url).hostname)
    // fetchStatusText, not a hand-rolled `consume`: a caller-supplied consume
    // never reaches the shared client's readBounded, so maxResponseBytes did
    // not apply to it and a hostile or wedged callback host could stream until
    // the runner OOMed (measured 52 MB buffered against a 1 KB cap). This
    // accessor returns the status alongside a BOUNDED body.
    return client.fetchStatusText(url, METADATA_TIMEOUT_MS)
  })()
}
