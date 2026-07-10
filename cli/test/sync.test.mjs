// ============================================================================
// Unit tests for the pure sandbox-sync engine (cli/src/lib/sync.mjs):
// hashing, ignore rules, directory walking, manifest building, diff
// application and tarball creation. Runs with `npm test` (node:test).
// ============================================================================

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import {
  hashFile,
  parseIgnoreRules,
  isIgnored,
  isDefaultExcluded,
  walkAppDir,
  buildManifest,
  selectUploadEntries,
  diffManifests,
  createTarball,
  toPosix,
} from '../src/lib/sync.mjs'

// sha256("hello world")
const HELLO_WORLD_SHA256 = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'

function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veltrix-sync-test-'))
  for (const [rel, content] of Object.entries(spec)) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

describe('hashFile', () => {
  test('produces the expected sha256 hex digest', () => {
    const root = makeTree({ 'file.txt': 'hello world' })
    try {
      assert.equal(hashFile(path.join(root, 'file.txt')), HELLO_WORLD_SHA256)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Ignore rules
// ---------------------------------------------------------------------------

describe('parseIgnoreRules / isIgnored', () => {
  test('skips comments and blank lines', () => {
    const rules = parseIgnoreRules('# a comment\n\n   \n*.log\n')
    assert.equal(rules.length, 1)
  })

  test('bare name matches at any depth', () => {
    const rules = parseIgnoreRules('*.log')
    assert.equal(isIgnored('debug.log', rules), true)
    assert.equal(isIgnored('deep/nested/debug.log', rules), true)
    assert.equal(isIgnored('debug.log.txt', rules), false)
  })

  test('? matches exactly one character', () => {
    const rules = parseIgnoreRules('file?.txt')
    assert.equal(isIgnored('file1.txt', rules), true)
    assert.equal(isIgnored('file12.txt', rules), false)
    assert.equal(isIgnored('file.txt', rules), false)
  })

  test('patterns with a slash are anchored to the app root', () => {
    const rules = parseIgnoreRules('docs/*.md')
    assert.equal(isIgnored('docs/readme.md', rules), true)
    assert.equal(isIgnored('docs/sub/readme.md', rules), false)
    assert.equal(isIgnored('other/docs/readme.md', rules), false)
  })

  test('leading slash anchors a bare name', () => {
    const rules = parseIgnoreRules('/secrets.txt')
    assert.equal(isIgnored('secrets.txt', rules), true)
    assert.equal(isIgnored('sub/secrets.txt', rules), false)
  })

  test('trailing slash means directory-only, contents included', () => {
    const rules = parseIgnoreRules('build/')
    assert.equal(isIgnored('build', rules, true), true)
    assert.equal(isIgnored('build/out.js', rules), true)
    assert.equal(isIgnored('sub/build/out.js', rules), true) // not anchored
    assert.equal(isIgnored('build', rules, false), false) // a FILE named build
  })

  test('** spans multiple segments', () => {
    const rules = parseIgnoreRules('fixtures/**/large.bin')
    assert.equal(isIgnored('fixtures/large.bin', rules), true)
    assert.equal(isIgnored('fixtures/a/b/large.bin', rules), true)
    assert.equal(isIgnored('other/large.bin', rules), false)
  })

  test('negation re-includes, last matching rule wins', () => {
    const rules = parseIgnoreRules('*.log\n!keep.log')
    assert.equal(isIgnored('debug.log', rules), true)
    assert.equal(isIgnored('keep.log', rules), false)
    assert.equal(isIgnored('sub/keep.log', rules), false)
  })

  test('files under an ignored directory are ignored', () => {
    const rules = parseIgnoreRules('coverage')
    assert.equal(isIgnored('coverage/lcov/index.html', rules), true)
  })
})

describe('isDefaultExcluded', () => {
  test('always excludes node_modules, .git, dist and .veltrix*', () => {
    for (const name of ['node_modules', '.git', 'dist', '.veltrixignore', '.veltrix-sync-state.json']) {
      assert.equal(isDefaultExcluded(name), true, name)
    }
    for (const name of ['src', 'manifest.yaml', 'distribution']) {
      assert.equal(isDefaultExcluded(name), false, name)
    }
  })
})

// ---------------------------------------------------------------------------
// Walking + manifest
// ---------------------------------------------------------------------------

describe('walkAppDir / buildManifest', () => {
  let root

  before(() => {
    root = makeTree({
      'manifest.yaml': 'id: demo-app\n',
      'config-types/indexes/deploy.ts': 'export {}\n',
      'lib/client.ts': 'export const x = 1\n',
      'node_modules/pkg/index.js': 'nope',
      '.git/config': 'nope',
      'dist/out.js': 'nope',
      '.veltrixignore': '*.tmp\n',
      'scratch/notes.tmp': 'ignored by .veltrixignore',
      'scratch/keep.md': 'kept',
    })
  })

  after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('applies default excludes and returns posix paths', () => {
    const files = walkAppDir(root)
    const paths = files.map((f) => f.path)
    assert.deepEqual(paths, [
      'config-types/indexes/deploy.ts',
      'lib/client.ts',
      'manifest.yaml',
      'scratch/keep.md',
      'scratch/notes.tmp', // no rules passed — .veltrixignore not applied here
    ])
    for (const p of paths) assert.ok(!p.includes('\\'), `posix path expected: ${p}`)
  })

  test('applies .veltrixignore rules when provided', () => {
    const files = walkAppDir(root, parseIgnoreRules('*.tmp'))
    const paths = files.map((f) => f.path)
    assert.ok(!paths.includes('scratch/notes.tmp'))
    assert.ok(paths.includes('scratch/keep.md'))
  })

  test('buildManifest returns {path, sha256, size} entries', () => {
    const manifest = buildManifest(root, parseIgnoreRules('*.tmp'))
    const entry = manifest.find((e) => e.path === 'manifest.yaml')
    assert.ok(entry)
    assert.equal(entry.size, Buffer.byteLength('id: demo-app\n'))
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// Diff application
// ---------------------------------------------------------------------------

describe('selectUploadEntries', () => {
  const entries = [
    { path: 'a.ts', sha256: 'x'.repeat(64), size: 1 },
    { path: 'b.ts', sha256: 'y'.repeat(64), size: 2 },
  ]

  test('selects exactly the requested entries', () => {
    const { selected, missing } = selectUploadEntries(entries, ['b.ts'])
    assert.deepEqual(selected.map((e) => e.path), ['b.ts'])
    assert.deepEqual(missing, [])
  })

  test('reports paths the server requested that no longer exist locally', () => {
    const { selected, missing } = selectUploadEntries(entries, ['a.ts', 'vanished.ts'])
    assert.deepEqual(selected.map((e) => e.path), ['a.ts'])
    assert.deepEqual(missing, ['vanished.ts'])
  })
})

describe('diffManifests', () => {
  test('detects added, changed and removed files', () => {
    const previous = [
      { path: 'same.ts', sha256: 'a'.repeat(64), size: 1 },
      { path: 'changed.ts', sha256: 'b'.repeat(64), size: 1 },
      { path: 'removed.ts', sha256: 'c'.repeat(64), size: 1 },
    ]
    const current = [
      { path: 'same.ts', sha256: 'a'.repeat(64), size: 1 },
      { path: 'changed.ts', sha256: 'd'.repeat(64), size: 2 },
      { path: 'added.ts', sha256: 'e'.repeat(64), size: 3 },
    ]
    const { changed, removed } = diffManifests(previous, current)
    assert.deepEqual(changed.sort(), ['added.ts', 'changed.ts'])
    assert.deepEqual(removed, ['removed.ts'])
  })
})

// ---------------------------------------------------------------------------
// Tarball
// ---------------------------------------------------------------------------

describe('createTarball', () => {
  test('archives exactly the requested paths as a gzip tar', async () => {
    const root = makeTree({
      'manifest.yaml': 'id: demo-app\n',
      'lib/util.ts': 'export const u = 1\n',
      'lib/skipme.ts': 'should not be archived\n',
    })
    try {
      const tarball = await createTarball(root, ['manifest.yaml', 'lib/util.ts'])

      // gzip magic bytes
      assert.equal(tarball[0], 0x1f)
      assert.equal(tarball[1], 0x8b)

      const archivePath = path.join(root, 'out.tgz')
      fs.writeFileSync(archivePath, tarball)
      const listed = []
      await tar.list({
        file: archivePath,
        onReadEntry: (entry) => listed.push({ path: toPosix(entry.path), type: String(entry.type) }),
      })

      const filePaths = listed.filter((e) => e.type === 'File').map((e) => e.path)
      assert.deepEqual(filePaths.sort(), ['lib/util.ts', 'manifest.yaml'])
      assert.ok(!filePaths.includes('lib/skipme.ts'))
      // no link/device entries — the server rejects them
      assert.ok(listed.every((e) => e.type === 'File' || e.type === 'Directory'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
