import { METADATA_TIMEOUT_MS, createHttpClient } from '@4cloudguru/pipeline-task-core'
import { Agent } from 'undici'
import { URL } from 'url'
import type { AuthorizeHost } from './egress'

export interface HttpResponse {
  status: number
  body: string
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
 * `rejectUnauthorized=false` disables TLS verification — only for an internal
 * callback fronted by a private CA the runner does not trust.
 */
export function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  rejectUnauthorized: boolean,
  authorizeHost: AuthorizeHost,
  /** `fetch` implementation, injectable so tests need no network. */
  fetchImpl?: typeof fetch,
): Promise<HttpResponse> {
  // One dispatcher per call, built only when the operator opted out of TLS
  // verification; Node's fetch has no other way to reach that socket option.
  const dispatcher = rejectUnauthorized ? undefined : new Agent({ connect: { rejectUnauthorized: false } })

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
    redirectPolicy: async (_originHost, next) => {
      await authorizeHost(next.host)
      return true
    },
  })

  return (async () => {
    await authorizeHost(new URL(url).hostname)
    return client.fetchWithTimeout(url, METADATA_TIMEOUT_MS, async (response) => ({
      status: response.status,
      body: await response.text(),
    }))
  })()
}
