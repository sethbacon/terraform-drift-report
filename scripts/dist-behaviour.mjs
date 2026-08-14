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
import { execFileSync } from 'node:child_process'

const DIST = process.argv[2] ?? new URL("../dist/index.js", import.meta.url).pathname
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

console.log(`\n${failures === 0 ? 'ALL DIST CHECKS PASSED' : failures + ' DIST CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
