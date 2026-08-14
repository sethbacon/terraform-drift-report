import {
  HttpError,
  METADATA_TIMEOUT_MS,
  createHttpClient,
  resolveEnvProxy,
  type ProxyEnvironment,
} from '@4cloudguru/pipeline-task-core'
import { Agent, ProxyAgent, type Dispatcher } from 'undici'
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
  /**
   * The runner's environment, read for `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`.
   * Defaults to `process.env`; injectable so tests need no global mutation.
   */
  env?: ProxyEnvironment
  /**
   * Registers a proxy credential with the job's mask. Wire to `core.setSecret`.
   *
   * A proxy URL may embed `user:password@`, and it reaches this process from the
   * environment rather than from an action input, so nothing else in the run has
   * had the chance to mask it.
   */
  setSecret?: (secret: string) => void
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
 *
 * On a self-hosted runner behind a mandatory egress proxy the request is routed
 * through it, because Node's `fetch` honours none of `HTTPS_PROXY` /
 * `HTTP_PROXY` / `NO_PROXY` on its own and the callback is the one outbound
 * request in this action that carries a credential and the plan contents — the
 * one an organisation most needs inside its chokepoint. The proxy decision is
 * re-taken for EVERY hop, never once for the original URL; see
 * {@link dispatcherFor}.
 */
export function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  authorizeHost: AuthorizeHost,
  options: HttpsClientOptions = {},
): Promise<HttpResponse> {
  const { caCert, fetchImpl, env, setSecret } = options
  // Built only when the operator supplied a trust anchor; Node's fetch has no
  // other way to reach that socket option. Used for the hops that go direct.
  const direct = caCert ? new Agent({ connect: { ca: caCert } }) : undefined
  // Keyed by proxy URL so a redirect chain reuses one connection pool per proxy
  // instead of leaking a fresh one per hop.
  const proxyAgents = new Map<string, ProxyAgent>()
  const masked = new Set<string>()

  /**
   * The dispatcher for ONE hop, chosen from that hop's own destination.
   *
   * Resolved per hop rather than once for the original URL because every part
   * of the decision belongs to the destination: `NO_PROXY` is matched against
   * it and its scheme picks the variable. A chain that redirects off the origin
   * — say from a proxied public host to an internal one covered by `NO_PROXY` —
   * has to be answered again, and resolving once would send the later hops
   * through the wrong route (or through a proxy that is not permitted to see
   * them at all).
   *
   * WHAT THIS DOES NOT DECIDE. A proxy changes which socket carries the
   * request, never which destination is permitted. `authorizeHost` still runs
   * against the DESTINATION host — the initial one below and every redirect hop
   * in `redirectPolicy` — and its subject is never the proxy: a CONNECT tunnel
   * to an unauthorized host is still unauthorized egress. Nothing here is
   * consulted by that decision, and nothing here can widen it.
   */
  function dispatcherFor(hopUrl: string): Dispatcher | undefined {
    let proxy: ReturnType<typeof resolveEnvProxy>
    try {
      proxy = resolveEnvProxy(hopUrl, env)
    } catch (error) {
      // Re-thrown NON-retryable, for the same reason the redirect refusal below
      // is: an unusable proxy variable is a configuration error, and the shared
      // client treats any non-HttpError as a transient transport failure, so a
      // plain throw would be retried three times over. Fail closed and once —
      // never silently direct, which is the failure that would put the callback
      // token outside the chokepoint the variable exists to enforce.
      throw new HttpError(error instanceof Error ? error.message : String(error), false)
    }
    if (!proxy) return direct
    // Masked before the agent is constructed, so a proxy that refuses the
    // connection cannot put the credential in the error text unmasked. Deduped
    // because a redirect chain resolves the same proxy repeatedly and each
    // registration is an ::add-mask:: line in the log.
    for (const secret of proxy.secrets) {
      if (masked.has(secret)) continue
      masked.add(secret)
      setSecret?.(secret)
    }
    let agent = proxyAgents.get(proxy.proxyUrl)
    if (!agent) {
      // `requestTls`, not `connect`: with a tunnel in play that is the TLS
      // handshake with the DESTINATION, which is the peer `caCert` vouches for.
      // Putting the anchor on the proxy leg instead would leave the destination
      // handshake on the default store and fail exactly the private-CA case the
      // input exists for.
      agent = new ProxyAgent(caCert ? { uri: proxy.proxyUrl, requestTls: { ca: caCert } } : { uri: proxy.proxyUrl })
      proxyAgents.set(proxy.proxyUrl, agent)
    }
    return agent
  }

  const client = createHttpClient({
    fetchImpl,
    fetchOptions: (hopUrl) => {
      const init: RequestInit = {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
      }
      const dispatcher = dispatcherFor(hopUrl)
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
    const parsed = new URL(url)
    // fetch drops URL userinfo on the floor: it is neither sent as an
    // Authorization header nor reported. An author who wrote
    // `https://user:secret@tsm.example.com/drift` got an unauthenticated
    // request, a 401, and a failure message that says nothing about the
    // credential this action silently discarded — while the secret still sat in
    // their workflow file. Refuse it and name the supported mechanism.
    if (parsed.username || parsed.password) {
      throw new Error(
        'callback-url must not embed credentials (user:password@host). They are not sent — ' +
          'authenticate with callback-token, which is transmitted as the X-TSM-Callback-Token header.',
      )
    }
    // Outside the retrying accessor, so this refusal is already fatal.
    await authorizeHost(parsed.hostname)
    // fetchStatusText, not a hand-rolled `consume`: a caller-supplied consume
    // never reaches the shared client's readBounded, so maxResponseBytes did
    // not apply to it and a hostile or wedged callback host could stream until
    // the runner OOMed (measured 52 MB buffered against a 1 KB cap). This
    // accessor returns the status alongside a BOUNDED body.
    return client.fetchStatusText(url, METADATA_TIMEOUT_MS)
  })()
}
