/**
 * Executes the REBUILT, MINIFIED dist/index.js and observes the four behaviours
 * this PR adds. --minify strips names, so grepping the bundle proves nothing;
 * this drives it and watches what it does.
 *
 * The bundle is a GitHub Action entrypoint, so it is driven the way the runner
 * drives it: INPUT_* env vars, a real $GITHUB_OUTPUT / $GITHUB_STATE file, and
 * stdout carrying the ::add-mask:: / ::error:: workflow commands.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { execFileSync } from 'node:child_process'

const DIST = process.argv[2] ?? new URL("../dist/index.js", import.meta.url).pathname
// action.yml declares TWO entrypoints — `main: dist/index.js` and
// `post: dist/cleanup.js` — and only the first was ever executed here. The post
// step is the one that deletes a report full of unredacted attribute values, so
// "it silently stopped working" is not a cosmetic failure. It is also the entry
// point that degrades most quietly: it exists only because the build line names
// a second source file, and a build that emitted just the first still exits 0.
// scripts/verify-bundle.mjs catches that against action.yml; this catches a
// cleanup.js that is present and does not work.
const CLEANUP = process.argv[3] ?? join(dirname(DIST), 'cleanup.js')
const work = mkdtempSync(join(tmpdir(), 'distproof-'))

// A real TLS endpoint, because the action refuses anything but https:// and the
// response path is what is under test. The throwaway CA is handed to the action
// through the ca-cert input, which also exercises the fail-closed TLS handling.
const keyFile = join(work, 'key.pem')
const certFile = join(work, 'cert.pem')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyFile, '-out', certFile, '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
], { stdio: 'ignore' })
const TLS = { key: readFileSync(keyFile), cert: readFileSync(certFile) }
const CA = readFileSync(certFile, 'utf8')

const plan = {
  resource_changes: [
    {
      address: 'aws_instance.web',
      change: { actions: ['update'], before: { size: 'a' }, after: { size: 'b' } },
    },
  ],
}
const planFile = join(work, 'plan.json')
writeFileSync(planFile, JSON.stringify(plan))

// Async, not spawnSync: the HTTPS endpoints below live in THIS process, and a
// synchronous spawn blocks the event loop so the server never accepts the
// connection the action is making. That failure surfaces as a connect timeout
// and looks exactly like a broken action.
function runAction(extraEnv) {
  const runnerTemp = mkdtempSync(join(work, 'runner-'))
  const outFile = join(runnerTemp, 'gh_output')
  const stateFile = join(runnerTemp, 'gh_state')
  writeFileSync(outFile, '')
  writeFileSync(stateFile, '')
  const env = {
    ...process.env,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: outFile,
    GITHUB_STATE: stateFile,
    'INPUT_PLAN-JSON-FILE': planFile,
    'INPUT_INCLUDE-MODULE-PROVENANCE': 'false',
    'INPUT_FAIL-ON-DRIFT': 'false',
    'INPUT_DETAIL': '',
    // The action now HONOURS these, so `...process.env` would otherwise let a
    // developer's own shell proxy decide where every check below sends its
    // callback — and the loopback endpoints these checks stand up are exactly
    // what such a proxy would refuse. Cleared to a known-empty baseline; the
    // proxy checks set them explicitly through extraEnv.
    HTTPS_PROXY: undefined,
    https_proxy: undefined,
    HTTP_PROXY: undefined,
    http_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
    ...extraEnv,
  }
  // An explicit `undefined` UNSETS the variable rather than passing the string
  // "undefined". This harness runs on a GitHub runner, which exports a real
  // GITHUB_SHA that `...process.env` would otherwise smuggle into every run —
  // and "the action sends no commit when it has none" is not observable if the
  // environment always has one.
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, [DIST], { env })
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', () =>
      resolve({
        stdout,
        stderr,
        runnerTemp,
        output: readFileSync(outFile, 'utf8'),
        state: readFileSync(stateFile, 'utf8'),
      }),
    )
  })
}

// The post entrypoint, driven the way the runner drives it: `core.getState(k)`
// reads `STATE_<k>` from the environment, which is how the main step's saved
// path reaches this process.
function runCleanup(state) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, [CLEANUP], { env: { ...process.env, ...state } })
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        ${detail}`}`)
  if (!ok) failures++
}

// ---------------------------------------------------------------- #12 ------
console.log('\n=== #12  report file custody ===')
{
  const r = await runAction({})
  const m = r.output.match(/summary-file<<(\S+)\n(.+)\n/)
  const file = m ? m[2] : null
  check('summary-file output is produced', !!file, r.stdout + r.stderr)
  if (file) {
    console.log(`        path: ${file}`)
    check('lives under RUNNER_TEMP (not /tmp)', file.startsWith(r.runnerTemp), `got ${file}`)
    const mode = statSync(file).mode & 0o777
    check('created 0600', mode === 0o600, `mode is 0${mode.toString(8)}`)
    check('directory name is unpredictable', /tsm-drift-\w{6,}/.test(dirname(file)), dirname(file))
    check('state saved for the post step', r.state.includes('summary-file'), r.state)
  }
  // two runs must not collide
  const a = (await runAction({})).output.match(/summary-file<<\S+\n(.+)\n/)?.[1]
  const b = (await runAction({})).output.match(/summary-file<<\S+\n(.+)\n/)?.[1]
  check('two runs get different paths', a !== b, `${a} vs ${b}`)
}

// ---------------------------------------------------------------- #11 ------
console.log('\n=== #11  token masked on every path ===')
{
  const TOKEN = 'tsm-super-secret-token-value'
  // callback-url deliberately absent: this is the partial-config branch that
  // previously skipped setSecret entirely.
  const r = await runAction({ 'INPUT_CALLBACK-TOKEN': TOKEN })
  check(
    '::add-mask:: emitted with only the token supplied',
    r.stdout.includes(`::add-mask::${TOKEN}`),
    r.stdout.split('\n').filter((l) => l.includes('add-mask') || l.includes('warning')).join(' | ') || '(no mask line)',
  )
  // and on an early failure, before the plan file is even read
  const early = await runAction({ 'INPUT_CALLBACK-TOKEN': TOKEN, 'INPUT_PLAN-JSON-FILE': join(work, 'nope.json') })
  check(
    '::add-mask:: emitted even when a later required input fails',
    early.stdout.includes(`::add-mask::${TOKEN}`),
    early.stdout.split('\n').slice(0, 3).join(' | '),
  )
}

// ------------------------------------------------------------ #16 / #9 -----
console.log('\n=== #16 / #9  bounded body + sanitised annotation ===')
await new Promise((resolve) => {
  // A hostile callback endpoint: 500 status, a huge body, control characters
  // and a forged workflow command in it.
  const HUGE = 20 * 1024 * 1024
  const server = createServer(TLS, (req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.write('\n::error::FORGED-BY-REMOTE\n\u0000\u001b[31m')
    res.write('X'.repeat(HUGE))
    res.end()
  })
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port
    const r = await runAction({
      'INPUT_CALLBACK-URL': `https://127.0.0.1:${port}/cb`,
      'INPUT_CALLBACK-TOKEN': 'tok',
      'INPUT_CALLBACK-ALLOWED-HOSTS': '127.0.0.1',
      'INPUT_CA-CERT': CA,
    })
    const all = r.stdout + r.stderr
    const errLine = all.split('\n').find((l) => l.startsWith('::error::')) ?? ''
    console.log(`        annotation length: ${errLine.length} chars (remote sent ${HUGE} bytes)`)
    check('the 20 MB body did not become a 20 MB annotation', errLine.length < 2000, `${errLine.length} chars`)
    check('no forged ::error:: from the remote body reached the log', !all.includes('FORGED-BY-REMOTE'), 'forged command present')
    check('no raw control characters in the annotation', !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(errLine), JSON.stringify(errLine.slice(0, 120)))
    check('the step still failed with a usable message', /::error::/.test(all), all.slice(0, 200))
    server.close(resolve)
  })
})

// A body UNDER the client's 10 MiB cap still reaches the error interpolation,
// which is the path truncateForLog guards. The oversize case above is rejected
// by the cap before it ever gets there, so it does not exercise this at all.
console.log('\n=== #9  a sub-cap hostile body still cannot flood the annotation ===')
await new Promise((resolve) => {
  const BODY = 200 * 1024
  const server = createServer(TLS, (req, res) => {
    res.writeHead(409, { 'content-type': 'text/plain' })
    res.end('\u0000\u001b[31mSUB-CAP-FORGED\n' + 'Q'.repeat(BODY))
  })
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port
    const r = await runAction({
      'INPUT_CALLBACK-URL': `https://127.0.0.1:${port}/cb`,
      'INPUT_CALLBACK-TOKEN': 'tok',
      'INPUT_CALLBACK-ALLOWED-HOSTS': '127.0.0.1',
      'INPUT_CA-CERT': CA,
    })
    const all = r.stdout + r.stderr
    const errLine = all.split('\n').find((l) => l.startsWith('::error::')) ?? ''
    console.log(`        annotation length: ${errLine.length} chars (remote sent ${BODY} bytes, under the cap)`)
    check('a 200 KB sub-cap body is truncated in the annotation', errLine.length < 1000, `${errLine.length} chars`)
    check('the truncation is declared, not silent', /more characters truncated/.test(errLine), errLine.slice(0, 200))
    check('control characters are stripped from a sub-cap body', !/[\u0000-\u001f\u007f]/.test(errLine), JSON.stringify(errLine.slice(0, 120)))
    server.close(resolve)
  })
})

// ---------------------------------------------------------------- #46 ------
// Provenance. The callback payload carried no commit at all, so a receiver
// storing these reports as a time series had counts and a summary but no way to
// say which commit's plan produced them. Asserted against the report file AND
// the bytes that actually leave the runner: the file is documented as the exact
// callback body, and a refactor that assembled the POST separately would keep
// the file right and send the wrong thing.
const SHA = '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12'
const reportOf = (r) => JSON.parse(readFileSync(r.output.match(/summary-file<<\S+\n(.+)\n/)[1], 'utf8'))

console.log('\n=== #46  the report is bound to the commit it was computed from ===')
{
  const r = await runAction({ GITHUB_SHA: SHA })
  check('commit_sha defaults to the runner GITHUB_SHA', reportOf(r).commit_sha === SHA, JSON.stringify(reportOf(r).commit_sha))

  const EXPLICIT = '9f1c0de5b8a74e2d3c6b1a0f4e7d8c9b0a1b2c3d'
  const e = await runAction({ GITHUB_SHA: SHA, 'INPUT_COMMIT-SHA': EXPLICIT })
  check('an explicit commit-sha input wins over GITHUB_SHA', reportOf(e).commit_sha === EXPLICIT, JSON.stringify(reportOf(e).commit_sha))

  // Absent, not empty: a receiver has to tell "no commit available" from "an
  // older action that never sent one", and "" reads as neither.
  const none = await runAction({ GITHUB_SHA: undefined })
  const body = reportOf(none)
  check('commit_sha is omitted entirely when there is no commit', !('commit_sha' in body), JSON.stringify(body.commit_sha))
}

console.log('\n=== #46  the commit reaches the callback, not just the local report ===')
await new Promise((resolve) => {
  let received = null
  const server = createServer(TLS, (req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      received = raw
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port
    const r = await runAction({
      GITHUB_SHA: SHA,
      'INPUT_CALLBACK-URL': `https://127.0.0.1:${port}/cb`,
      'INPUT_CALLBACK-TOKEN': 'tok',
      'INPUT_CALLBACK-ALLOWED-HOSTS': '127.0.0.1',
      'INPUT_CA-CERT': CA,
    })
    check('the callback was actually issued', received !== null, r.stdout + r.stderr)
    const posted = received ? JSON.parse(received) : {}
    check('the POSTed body carries commit_sha', posted.commit_sha === SHA, JSON.stringify(posted.commit_sha))
    check('it matches the report file byte for byte', posted.commit_sha === reportOf(r).commit_sha, `${posted.commit_sha} vs ${reportOf(r).commit_sha}`)
    server.close(resolve)
  })
})
// ---------------------------------------------------------------- #21 ------
// Egress proxy. The unit suite injects both the environment and the mask sink,
// so NEITHER of the two entrypoint wirings this depends on — that the resolver
// defaults to `process.env`, and that `core.setSecret` is the sink — is
// observable there. They are observable here, in the bundle the runner executes.
//
// A minimal forward proxy: it answers CONNECT by splicing a TCP socket to the
// requested destination, which is the tunnel an enterprise egress proxy gives.
function startProxy() {
  const connects = []
  const server = createHttpServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, clientSocket, head) => {
    connects.push(req.url ?? '')
    const [host, port] = (req.url ?? '').split(':')
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  return { server, connects }
}

// Stands up a TLS callback endpoint and a proxy in front of it, runs the action
// against them, and hands back what each side observed.
function withProxiedCallback(extraEnv, proxyUrlFor) {
  return new Promise((resolve) => {
    let received = null
    const endpoint = createServer(TLS, (req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        received = raw
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    const { server: proxy, connects } = startProxy()
    endpoint.listen(0, '127.0.0.1', () => {
      proxy.listen(0, '127.0.0.1', async () => {
        const endpointPort = endpoint.address().port
        const proxyPort = proxy.address().port
        const r = await runAction({
          'INPUT_CALLBACK-URL': `https://127.0.0.1:${endpointPort}/cb`,
          'INPUT_CALLBACK-TOKEN': 'tok',
          'INPUT_CALLBACK-ALLOWED-HOSTS': '127.0.0.1',
          'INPUT_CA-CERT': CA,
          HTTPS_PROXY: proxyUrlFor(proxyPort),
          ...extraEnv,
        })
        endpoint.close(() => proxy.close(() => resolve({ r, received, connects, endpointPort })))
      })
    })
  })
}

console.log('\n=== #21  the callback honours the runner proxy from its own environment ===')
{
  const { r, received, connects, endpointPort } = await withProxiedCallback({}, (p) => `http://127.0.0.1:${p}`)
  const all = r.stdout + r.stderr
  // The load-bearing one. Both servers are on loopback, so a bundle that
  // ignored HTTPS_PROXY entirely would ALSO deliver the callback and pass every
  // other assertion here — the tunnel record is the only thing that separates
  // "through the chokepoint" from "around it".
  check(
    'the proxy saw a CONNECT to the callback destination',
    connects.length === 1 && connects[0] === `127.0.0.1:${endpointPort}`,
    JSON.stringify(connects),
  )
  check('the callback still arrived through the tunnel', received !== null, all.slice(0, 300))
  check('the step succeeded', !/::error::/.test(all), all.split('\n').filter((l) => l.startsWith('::error::')).join(' | '))
}

console.log('\n=== #21  NO_PROXY is honoured from the runner environment ===')
{
  const { r, received, connects } = await withProxiedCallback(
    { NO_PROXY: '127.0.0.1' },
    (p) => `http://127.0.0.1:${p}`,
  )
  check('the proxy was never dialled', connects.length === 0, JSON.stringify(connects))
  check('the callback went direct and arrived', received !== null, (r.stdout + r.stderr).slice(0, 300))
}

console.log('\n=== #21  a proxy credential reaches the job mask ===')
{
  // The proxy URL arrives from the ENVIRONMENT, not from an action input, so
  // nothing earlier in the run has masked it. This is the only layer that can
  // observe `core.setSecret` actually being the sink.
  const { r, connects } = await withProxiedCallback({}, (p) => `http://bob:hunter2@127.0.0.1:${p}`)
  check('::add-mask:: emitted for the proxy password', r.stdout.includes('::add-mask::hunter2'), r.stdout.split('\n').filter((l) => l.includes('add-mask')).join(' | ') || '(no mask line)')
  check('the credentialed proxy still carried the callback', connects.length === 1, JSON.stringify(connects))
}

console.log('\n=== #21  a proxy is not a way around egress authorization ===')
{
  // The destination is refused by callback-allowed-hosts, and a configured
  // proxy must not change that: a CONNECT tunnel to an unauthorized host is
  // still unauthorized egress. Allowing the PROXY host is the laundering
  // attempt — 127.0.0.1 names the proxy here too, so the allowlist below
  // permits it and the destination is refused all the same.
  const { r, received, connects } = await withProxiedCallback(
    { 'INPUT_CALLBACK-ALLOWED-HOSTS': 'tsm.example.com' },
    (p) => `http://127.0.0.1:${p}`,
  )
  const all = r.stdout + r.stderr
  check('the step failed', /::error::/.test(all), all.slice(0, 200))
  check('the refusal names the destination and the input', /127\.0\.0\.1.*callback-allowed-hosts/.test(all), all.split('\n').find((l) => l.startsWith('::error::')) ?? '(no error line)')
  check('nothing was tunnelled', connects.length === 0, JSON.stringify(connects))
  check('the callback token never left the runner', received === null, 'the endpoint received a request')
}

console.log('\n=== #21  an unusable proxy variable fails closed rather than going direct ===')
{
  const { r, received, connects } = await withProxiedCallback({}, () => 'not a url')
  const all = r.stdout + r.stderr
  const errLine = all.split('\n').find((l) => l.startsWith('::error::')) ?? ''
  check('the step failed', /::error::/.test(all), all.slice(0, 200))
  check('the refusal names the variable', /HTTPS_PROXY/.test(errLine), errLine || '(no error line)')
  check('the variable value is never echoed', !/not a url/.test(all), errLine)
  check('the callback did NOT quietly go direct', received === null, 'the endpoint received a request')
  check('and nothing was tunnelled either', connects.length === 0, JSON.stringify(connects))
}

// ------------------------------------------------- completeness markers ----
// The contract's five markers describe what the check did NOT do. The body was
// assembled by naming the contract's fields one at a time, so all five were
// dropped on the floor: a plan the action could not read left the runner as
// `drifted: false` with zero counts, byte-identical to a verified-clean run, and
// TSM auto-resolved the live drift record on it.
//
// Driven here rather than only in the unit suite because the marker has to
// survive the BUNDLE — this is the artifact consumers execute, and `--minify`
// means nothing about it can be established by reading it.
console.log('\n=== completeness markers reach the wire ===')
{
  const { summarize } = await import('@4cloudguru/terraform-drift-contract')
  const MARKERS = ['unparseable', 'unmasked', 'truncated', 'omitted_entries', 'omitted_attrs']

  const planWith = (name, doc) => {
    const p = join(work, `${name}.json`)
    writeFileSync(p, JSON.stringify(doc))
    return p
  }

  // A TLS endpoint that records the bytes the bundle actually POSTs. The report
  // file is read from the same run, because it is documented as the exact
  // callback body and a refactor could keep one right while sending the other.
  function postedFor(planPath) {
    return new Promise((resolve) => {
      let received = null
      const server = createServer(TLS, (req, res) => {
        let raw = ''
        req.on('data', (d) => (raw += d))
        req.on('end', () => {
          received = raw
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        })
      })
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port
        const r = await runAction({
          'INPUT_PLAN-JSON-FILE': planPath,
          'INPUT_CALLBACK-URL': `https://127.0.0.1:${port}/cb`,
          'INPUT_CALLBACK-TOKEN': 'tok',
          'INPUT_CALLBACK-ALLOWED-HOSTS': '127.0.0.1',
          'INPUT_CA-CERT': CA,
        })
        server.close(() => resolve({ r, posted: received ? JSON.parse(received) : null }))
      })
    })
  }

  // `{}` parses as JSON but is not a plan: no resource_changes at all. This is a
  // truncated `terraform show -json`, a wrong file, an empty document — every
  // "we never finished checking" case, and until now every one of them reached
  // the receiver as a clean result.
  const UNREADABLE = {}
  const CLEAN = { resource_changes: [] }
  const UNMASKED = {
    resource_changes: [
      { address: 'aws_instance.x', change: { actions: ['update'], before: { size: 1 }, after: { size: 2 } } },
    ],
  }
  const MASKED = {
    resource_changes: [
      {
        address: 'aws_instance.x',
        change: {
          actions: ['update'],
          before: { size: 1 },
          after: { size: 2 },
          before_sensitive: {},
          after_sensitive: {},
        },
      },
    ],
  }
  const CAPPED = {
    resource_changes: Array.from({ length: 503 }, (_unused, i) => ({
      address: `aws_s3_bucket.b${i}`,
      change: { actions: ['create'], before: null, after: {} },
    })),
  }

  const broken = await postedFor(planWith('unreadable', UNREADABLE))
  check('the callback was issued for an unreadable document', broken.posted !== null, broken.r.stdout + broken.r.stderr)
  check(
    'an unreadable document is POSTed as unparseable',
    broken.posted?.unparseable === true,
    JSON.stringify(broken.posted?.unparseable),
  )
  // The whole point: on every other field this body is identical to CLEAN
  // below. Without the marker the receiver cannot tell them apart, and resolved
  // the record on both.
  check(
    'and it is otherwise indistinguishable from clean — 0/0/0, drifted false',
    broken.posted?.added === 0 &&
      broken.posted?.changed === 0 &&
      broken.posted?.destroyed === 0 &&
      broken.posted?.drifted === false,
    JSON.stringify(broken.posted),
  )
  check(
    'the report file agrees with the bytes that left the runner',
    reportOf(broken.r).unparseable === true,
    JSON.stringify(reportOf(broken.r).unparseable),
  )

  // Positive control. A body that hardcoded `unparseable: true` satisfies every
  // assertion above; only a run where the value is genuinely false separates a
  // forwarded marker from a constant. Same for each pair below.
  const clean = await postedFor(planWith('clean', CLEAN))
  check(
    'a genuinely clean plan is POSTed as parseable (positive control)',
    clean.posted?.unparseable === false,
    JSON.stringify(clean.posted?.unparseable),
  )

  const unmasked = await postedFor(planWith('unmasked', UNMASKED))
  check(
    'a change with no sensitivity metadata sets unmasked',
    unmasked.posted?.unmasked === true,
    JSON.stringify(unmasked.posted?.unmasked),
  )
  const masked = await postedFor(planWith('masked', MASKED))
  check(
    'a change carrying sensitivity mirrors does not (positive control)',
    masked.posted?.unmasked === false,
    JSON.stringify(masked.posted?.unmasked),
  )

  const capped = await postedFor(planWith('capped', CAPPED))
  check(
    'a capped summary POSTs truncated + how many rows were dropped',
    capped.posted?.truncated === true && capped.posted?.omitted_entries === 3,
    JSON.stringify({ truncated: capped.posted?.truncated, omitted_entries: capped.posted?.omitted_entries }),
  )
  // The counts are NOT capped, so 503 creates arrive alongside 500 rows. That
  // discrepancy is only legible because omitted_entries travels with it.
  check(
    'the counts stay whole while the summary is capped',
    capped.posted?.added === 503 && capped.posted?.summary?.length === 500,
    JSON.stringify({ added: capped.posted?.added, rows: capped.posted?.summary?.length }),
  )
  check(
    'an uncapped report says so rather than staying silent (positive control)',
    unmasked.posted?.truncated === false &&
      unmasked.posted?.omitted_entries === 0 &&
      unmasked.posted?.omitted_attrs === 0,
    JSON.stringify({
      truncated: unmasked.posted?.truncated,
      omitted_entries: unmasked.posted?.omitted_entries,
      omitted_attrs: unmasked.posted?.omitted_attrs,
    }),
  )

  // The class guard. Fails on the NEXT field the contract adds, not just the
  // five dropped this time — which is the difference between fixing an omission
  // and closing the defect that produced it.
  const computed = summarize(CAPPED)
  const dropped = Object.keys(computed).filter((k) => !(k in (capped.posted ?? {})))
  check('every field the contract computes is on the wire', dropped.length === 0, `dropped: ${dropped.join(', ')}`)
  check(
    'and each marker carries the contract-computed value, not a constant',
    MARKERS.every((m) => JSON.stringify(capped.posted?.[m]) === JSON.stringify(computed[m])),
    MARKERS.map((m) => `${m}: ${JSON.stringify(capped.posted?.[m])} vs ${JSON.stringify(computed[m])}`).join(' | '),
  )
  // The names belong to the receiver: TSM decodes them as the json tags of
  // `completeness` (internal/api/drift_records.go) and its own generated jq
  // templates post exactly these keys. The callback deliberately does not use
  // DisallowUnknownFields, so a rename here is a silent drop there.
  check(
    'the snake_case wire names the receiver decodes are the ones sent',
    MARKERS.every((m) => m in (capped.posted ?? {})),
    JSON.stringify(Object.keys(capped.posted ?? {})),
  )
}

// ------------------------------------------------------- post entrypoint ----
// Everything above drives dist/index.js. dist/cleanup.js is the other half of
// what consumers execute and had no coverage of any kind: `npm test` exercises
// src/cleanup.ts, and the staleness gates only prove the bundle matches a build
// of itself — which a stub satisfies byte-for-byte.
console.log('\n=== the post step runs and removes the report ===')
{
  // The real flow: the main step writes the report and saves its path, exactly
  // as the runner carries it into the post step.
  const r = await runAction({})
  const file = r.output.match(/summary-file<<\S+\n(.+)\n/)?.[1]
  const dir = file ? dirname(file) : null
  check('the main step left a report for the post step to remove', !!file && existsSync(file), String(file))

  const c = await runCleanup({ 'STATE_summary-file': file ?? '' })
  // Positive observation paired with the negative one, per the rule this file
  // follows: "the report is gone" is also true of a bundle that threw on
  // require and never deleted anything, so the exit status is asserted too.
  check('dist/cleanup.js exits 0', c.code === 0, `exit ${c.code}: ${c.stderr.slice(0, 300)}`)
  check('the report file is gone', !!file && !existsSync(file), `${file} is still present`)
  check(
    'the whole mkdtemp directory goes, not just the file',
    !!dir && !existsSync(dir),
    `${dir} is still present`,
  )
}

console.log('\n=== the post step is a no-op when the main step saved nothing ===')
{
  const c = await runCleanup({})
  check('exits 0 with no summary-file state', c.code === 0, `exit ${c.code}: ${c.stderr.slice(0, 300)}`)
}

console.log('\n=== a cleanup failure never fails the job ===')
{
  // Best-effort by contract. An already-removed report is what a re-run of the
  // post step, or a runner that cleared RUNNER_TEMP first, looks like.
  const c = await runCleanup({ 'STATE_summary-file': join(work, 'no-such-dir', 'tsm-drift-report.json') })
  check('exits 0 when the report is already gone', c.code === 0, `exit ${c.code}: ${c.stderr.slice(0, 300)}`)
}

console.log(`\n${failures === 0 ? 'ALL DIST CHECKS PASSED' : failures + ' DIST CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
