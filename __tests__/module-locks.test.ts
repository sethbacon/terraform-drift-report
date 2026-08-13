import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moduleCallsPlan } from '@4cloudguru/terraform-drift-contract'
import { projectModuleLocks, readModuleLocks } from '../src/module-locks'

/**
 * The class test for credentials riding out of the runner inside
 * `module_locks`.
 *
 * `.terraform/modules/modules.json` is Terraform's RESOLVED view of the very
 * `source` arguments the plan's configuration block reports, so every credential
 * shape the contract already strips from `module_calls` appears here too — and
 * used to be forwarded verbatim, into both the callback body and the
 * world-readable temp report.
 *
 * The rows are therefore one row per shape the contract's scrubber handles,
 * plus the ordinary addresses that must pass through untouched, because a
 * projection that mangles a registry source would break the backend's
 * (host, source) → locked-version join.
 */

interface SourceRow {
  what: string
  source: string
  expect: string
  /** Substring that must not survive into the emitted payload. */
  secret?: string
}

const SOURCE_ROWS: SourceRow[] = [
  // --- URL userinfo, the shape the issue names ---
  {
    what: 'git over https with user:token userinfo',
    source: 'git::https://x-access-token:ghp_realtokenvalue@github.com/org/mod.git',
    expect: 'git::https://(redacted)@github.com/org/mod.git',
    secret: 'ghp_realtokenvalue',
  },
  {
    what: 'a bare token as userinfo (no colon)',
    source: 'git::https://ghp_baretokenvalue@github.com/org/mod.git',
    expect: 'git::https://(redacted)@github.com/org/mod.git',
    secret: 'ghp_baretokenvalue',
  },
  {
    what: 'userinfo preserved alongside the ref selector',
    source: 'git::https://oauth2:glpat_realtokenvalue@gitlab.com/org/mod.git?ref=v1.2.3',
    expect: 'git::https://(redacted)@gitlab.com/org/mod.git?ref=v1.2.3',
    secret: 'glpat_realtokenvalue',
  },
  {
    what: 'ssh userinfo',
    source: 'git::ssh://git@github.com/org/mod.git',
    expect: 'git::ssh://(redacted)@github.com/org/mod.git',
  },
  {
    what: 'plain https basic-auth on an internal artifact proxy',
    source: 'https://svc:hunter2password@proxy.internal/mod.zip',
    expect: 'https://(redacted)@proxy.internal/mod.zip',
    secret: 'hunter2password',
  },

  // --- credential-bearing query parameters, the shape redactUrlUserInfo misses ---
  {
    what: 'a go-getter sshkey parameter (a base64 private key)',
    source: 'git::https://github.com/org/mod.git?sshkey=BASE64PRIVATEKEYMATERIAL',
    expect: 'git::https://github.com/org/mod.git?sshkey=(redacted)',
    secret: 'BASE64PRIVATEKEYMATERIAL',
  },
  {
    what: 'an S3 presigned signature',
    source: 's3::https://s3.amazonaws.com/bucket/mod.zip?X-Amz-Signature=deadbeefsignature',
    expect: 's3::https://s3.amazonaws.com/bucket/mod.zip?X-Amz-Signature=(redacted)',
    secret: 'deadbeefsignature',
  },
  {
    what: 'a token parameter next to a ref, which alone survives',
    source: 'git::https://github.com/org/mod.git?ref=v2.0.0&token=secrettokenvalue',
    expect: 'git::https://github.com/org/mod.git?ref=v2.0.0&token=(redacted)',
    secret: 'secrettokenvalue',
  },
  {
    what: 'both shapes at once',
    source: 'git::https://user:ghp_bothshapes@github.com/org/mod.git?ref=main&sshkey=KEYMATERIAL',
    expect: 'git::https://(redacted)@github.com/org/mod.git?ref=main&sshkey=(redacted)',
    secret: 'ghp_bothshapes',
  },

  // --- the ordinary addresses that must pass through byte-for-byte ---
  {
    what: 'a public registry source (the join key the backend actually reads)',
    source: 'terraform-aws-modules/vpc/aws',
    expect: 'terraform-aws-modules/vpc/aws',
  },
  {
    what: 'a private registry source with an explicit host',
    source: 'app.terraform.io/acme/vpc/aws',
    expect: 'app.terraform.io/acme/vpc/aws',
  },
  {
    what: 'a registry source with a subdirectory selector',
    source: 'terraform-aws-modules/vpc/aws//modules/subnets',
    expect: 'terraform-aws-modules/vpc/aws//modules/subnets',
  },
  {
    what: 'a credential-free git source',
    source: 'git::https://github.com/org/mod.git?ref=v1.0.0',
    expect: 'git::https://github.com/org/mod.git?ref=v1.0.0',
  },
  { what: 'a local path', source: './modules/db', expect: './modules/db' },
  { what: 'the root module (empty source)', source: '', expect: '' },
]

describe('module_locks sources are scrubbed', () => {
  it.each(SOURCE_ROWS)('$what', (row) => {
    const [lock] = projectModuleLocks([{ Key: 'vpc', Source: row.source, Version: '5.3.0', Dir: '.terraform/modules/vpc' }])
    expect(lock.Source).toBe(row.expect)
    if (row.secret) {
      expect(JSON.stringify(lock)).not.toContain(row.secret)
    }
  })

  /**
   * The point of the fix, not merely a consequence of it: `module_locks` reuses
   * the contract's own scrubber, so the two provenance fields cannot redact the
   * same address differently. A local second implementation is exactly what
   * would redden this row as the contract evolves.
   */
  it.each(SOURCE_ROWS)('redacts identically to module_calls: $what', (row) => {
    const viaCalls = moduleCallsPlan({
      configuration: { root_module: { module_calls: { vpc: { source: row.source } } } },
    }) as { configuration: { root_module: { module_calls: { vpc: { source?: string } } } } }
    const [lock] = projectModuleLocks([{ Source: row.source }])
    expect(lock.Source).toBe(viaCalls.configuration.root_module.module_calls.vpc.source ?? '')
  })
})

describe('module_locks is projected, not forwarded verbatim', () => {
  it('keeps Key/Source/Version and drops everything else', () => {
    expect(
      projectModuleLocks([
        { Key: '', Source: '', Dir: '.' },
        { Key: 'vpc', Source: 'terraform-aws-modules/vpc/aws', Version: '5.3.0', Dir: '.terraform/modules/vpc' },
      ]),
    ).toEqual([{ Key: '', Source: '' }, { Key: 'vpc', Source: 'terraform-aws-modules/vpc/aws', Version: '5.3.0' }])
  })

  it('drops a field Terraform might add later, by construction', () => {
    const [lock] = projectModuleLocks([
      { Key: 'vpc', Source: 'acme/vpc/aws', Version: '1.0.0', FutureField: 'anything-at-all' },
    ])
    expect(JSON.stringify(lock)).not.toContain('anything-at-all')
    expect(Object.keys(lock)).toEqual(['Key', 'Source', 'Version'])
  })

  it.each([
    ['a non-array Modules member', { Modules: {} }],
    ['a missing Modules member', {}],
    ['a manifest that is not an object', 'nope'],
  ])('yields no locks for %s', (_what, doc) => {
    expect(projectModuleLocks((doc as { Modules?: unknown })?.Modules)).toEqual([])
  })

  it('survives a non-object entry', () => {
    expect(projectModuleLocks([null, 'x', 7])).toEqual([{}, {}, {}])
  })
})

describe('readModuleLocks reads the manifest off disk', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tdr-locks-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const write = (name: string, content: string): string => {
    const p = join(dir, name)
    writeFileSync(p, content, 'utf8')
    return p
  }

  it('scrubs a real manifest end to end', () => {
    const manifest = write(
      'modules.json',
      JSON.stringify({
        Modules: [
          { Key: '', Source: '', Dir: '.' },
          {
            Key: 'internal',
            Source: 'git::https://x-access-token:ghp_endtoendtoken@github.com/acme/mod.git?ref=v1',
            Dir: '/home/runner/work/repo/repo/.terraform/modules/internal',
          },
          { Key: 'vpc', Source: 'terraform-aws-modules/vpc/aws', Version: '5.3.0', Dir: '.terraform/modules/vpc' },
        ],
      }),
    )

    const emitted = JSON.stringify(readModuleLocks(manifest))
    expect(emitted).not.toContain('ghp_endtoendtoken')
    // The runner's absolute checkout path is not provenance either.
    expect(emitted).not.toContain('/home/runner/work')
    expect(JSON.parse(emitted)).toEqual({
      Modules: [
        { Key: '', Source: '' },
        { Key: 'internal', Source: 'git::https://(redacted)@github.com/acme/mod.git?ref=v1' },
        { Key: 'vpc', Source: 'terraform-aws-modules/vpc/aws', Version: '5.3.0' },
      ],
    })
  })

  it('returns null when the manifest is absent', () => {
    expect(readModuleLocks(join(dir, 'nope.json'))).toBeNull()
  })

  it('returns null when the manifest is not JSON', () => {
    expect(readModuleLocks(write('broken.json', '{not json'))).toBeNull()
  })
})
