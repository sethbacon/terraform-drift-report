/**
 * Refuses to certify a dist/ that will not load on a runner.
 *
 * WHY THIS EXISTS. dist/ is committed, minified and never read by a human, and
 * nothing else in this repo looks at it in a way that could notice it is dead:
 *
 *  - `npm run lint` and `npm test` read src/, never the bundle;
 *  - both dist gates compare dist/ to a fresh build OF ITSELF, so a broken
 *    bundle that has been committed matches its own rebuild byte-for-byte and
 *    passes;
 *  - the behaviour harness does execute dist/, but only after someone has
 *    already committed the broken bundle.
 *
 * WHAT CHANGED WITH THE BUNDLER. Under `@vercel/ncc` the failure mode was a
 * quiet one: webpack planted a `webpackMissingModule` stub where a require it
 * could not resolve should have been, and ncc 0.44.1 exited 0 around it. That
 * marker is webpack's, and esbuild never emits it — a guard still keyed on the
 * string would go green forever while checking nothing.
 *
 * esbuild fails loudly on a top-level import it cannot resolve — `error: Could
 * not resolve "x"`, exit 1, nothing written. It does NOT fail on the three
 * shapes below, every one of which was reproduced against esbuild 0.28.2 before
 * this guard was written, and every one of which exits 0 and writes a bundle
 * that dies with MODULE_NOT_FOUND on the first line the runner executes:
 *
 *  1. `--external:undici` on the build line. Exit 0, `require("undici")` in the
 *     output. `--packages=external` is the same defect wholesale.
 *  2. `require("not-installed")` inside a try/catch — the optional-dependency
 *     idiom. esbuild does not resolve it, does not error, and does not even
 *     WARN; the literal is copied straight through.
 *  3. `require(someExpression)`. For a CJS/node build esbuild leaves the call
 *     alone, silently, because `require` is a real global there.
 *
 * The invariant this enforces, therefore: NOTHING in an emitted bundle resolves
 * a module at run time except a Node builtin. A literal specifier that is not a
 * builtin gets looked up in a node_modules that is not shipped beside dist/; a
 * computed one is a resolution esbuild could not perform either. Both land
 * exactly where the old webpack stub landed — MODULE_NOT_FOUND, before the
 * action's first line.
 *
 * The two structural checks are bundler-independent and stay as they were: a
 * build that emitted nothing, and an entrypoint action.yml declares that this
 * build did not produce.
 *
 * NOT COVERED HERE, deliberately: esbuild does not type-check, where ncc's
 * ts-loader did and failed the build on a type error. That gap is closed in the
 * build script itself (`npm run build` runs `tsc --noEmit` first), because it
 * is a property of the SOURCE and cannot be recovered by reading the minified
 * output.
 *
 * Run: node scripts/verify-bundle.mjs [dist-dir] [action.yml]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distDir = process.argv[2] ?? join(root, 'dist')
const actionYml = process.argv[3] ?? join(root, 'action.yml')
// action.yml's `main:`/`post:` paths are relative to the action.yml that
// declares them, not to this script. Resolving them against the script's own
// parent instead works only while both sit in the same checkout, and makes the
// entrypoint check silently unsatisfiable — every path "missing" — the moment
// this is pointed at a tree somewhere else.
const actionRoot = dirname(actionYml)

/**
 * The specifier of every `require(...)` and dynamic `import(...)` call site in a
 * bundle — `null` where the call carries an expression rather than a literal.
 *
 * The lookbehind rejects `foo.require(` and identifiers merely ending in
 * `require`, which is what minified output is full of. Each hit is then
 * classified by the character following the paren: a quote means esbuild
 * resolved the specifier and wrote it out, anything else (including a template
 * literal) means the call survived with a run-time resolution in it.
 */
function moduleResolutions(text) {
  const found = []
  for (const re of [/(?<![.\w$])require\s*\(\s*/g, /(?<![.\w$])import\s*\(\s*/g]) {
    while (re.exec(text) !== null) {
      const quote = text[re.lastIndex]
      if (quote !== '"' && quote !== "'") {
        found.push(null)
        continue
      }
      const end = text.indexOf(quote, re.lastIndex + 1)
      if (end === -1) continue // unterminated: not a call site we can read
      found.push(text.slice(re.lastIndex + 1, end))
    }
  }
  return found
}

let failures = 0
const fail = (message) => {
  console.error(`::error::${message}`)
  failures++
}

/** Every .js the build emitted, recursively. */
function emittedBundles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...emittedBundles(p))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p)
  }
  return out
}

/**
 * The entrypoints action.yml declares, read with a block-YAML subset reader
 * rather than a YAML dependency. This runs inside `npm run build`, and a guard
 * that needs its own dependency tree to answer is one more thing that can be
 * missing on the machine the bundle is built on.
 */
function declaredEntrypoints(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((l) => /^runs:\s*$/.test(l))
  if (start === -1) return []
  const found = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // dedented back out of the runs: block
    const m = /^\s+(main|pre|post):\s*(\S+)\s*$/.exec(line)
    if (m) found.push(m[2])
  }
  return found
}

const bundles = existsSync(distDir) ? emittedBundles(distDir) : []

// An empty universe has to fail rather than pass vacuously. "No bundles found"
// is exactly what a build that emitted nothing looks like, and every check
// below is trivially satisfied by it.
if (bundles.length === 0) {
  fail(`No bundles found under ${relative(root, distDir) || distDir}. The build emitted nothing to verify.`)
}

// Bidirectional: the resolution scan below proves the bundles that EXIST are
// sound, which says nothing about one that was never emitted. action.yml is the
// contract for what has to be there, so it is what the build is measured
// against — a `post:` script that silently stopped being produced would
// otherwise surface only as a consumer's job failing at the end of every run.
const entrypoints = declaredEntrypoints(actionYml)
if (entrypoints.length === 0) {
  fail(
    `${relative(root, actionYml)} declares no runs.main, so nothing pins what this build has to ` +
      `produce. Refusing to certify a bundle against an empty contract.`,
  )
}
for (const entrypoint of entrypoints) {
  if (!existsSync(join(actionRoot, entrypoint))) {
    fail(`action.yml runs '${entrypoint}', which this build did not produce.`)
  }
}

let resolved = 0
for (const file of bundles) {
  const text = readFileSync(file, 'utf8')
  const resolutions = moduleResolutions(text)
  resolved += resolutions.length

  const external = [...new Set(resolutions.filter((s) => s !== null && !isBuiltin(s)))]
  if (external.length > 0) {
    fail(
      `${relative(root, file)} resolves ${external.map((s) => `'${s}'`).join(', ')} at run time. ` +
        `Those are not Node builtins, so the runner looks for them in a node_modules beside ` +
        `dist/ — which does not exist — and the action dies with MODULE_NOT_FOUND before its ` +
        `first line. Either the build line excluded them (--external / --packages=external), or ` +
        `they are required inside a try/catch, which esbuild copies through without resolving ` +
        `and without warning. Bundle them or vendor them; do NOT commit this bundle.`,
    )
  }

  const dynamic = resolutions.filter((s) => s === null).length
  if (dynamic > 0) {
    fail(
      `${relative(root, file)} contains ${dynamic} ${dynamic === 1 ? 'call' : 'calls'} ` +
        `to require()/import() with a computed specifier. esbuild resolved nothing there and said ` +
        `nothing about it — for a CJS/node build it leaves such a call exactly as written — so ` +
        `whatever it names is looked up at run time in a node_modules that is not shipped. ` +
        `Do NOT commit this bundle.`,
    )
  }
}

if (failures > 0) {
  console.error(`\n${failures} bundle check(s) failed — refusing to certify dist/.`)
  process.exit(1)
}

console.log(
  `Bundle verification passed: ${bundles.length} emitted bundle(s), ` +
    `${entrypoints.length} declared entrypoint(s), ${resolved} run-time module resolution(s), ` +
    `all of them Node builtins.`,
)
