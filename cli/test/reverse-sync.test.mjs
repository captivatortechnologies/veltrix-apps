// ============================================================================
// Unit tests for the reverse-sync core (cli/src/lib/reverse-sync.mjs):
// the echo guard, the conflict rule, the atomic-write helper, path safety,
// and hash-diff reconciliation. Runs with `npm test` (node:test).
// ============================================================================

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  sha256Hex,
  hashLocalFile,
  decodeFileContent,
  makeOriginClientId,
  safeResolve,
  shouldIgnoreEvent,
  decideApply,
  atomicWrite,
  reconcile,
} from '../src/lib/reverse-sync.mjs'

// sha256("hello world")
const HELLO_WORLD_SHA256 = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'veltrix-reverse-test-'))
}

// ---------------------------------------------------------------------------
// Hashing + content decoding
// ---------------------------------------------------------------------------

describe('sha256Hex / hashLocalFile / decodeFileContent', () => {
  test('sha256Hex matches the known digest for strings and buffers', () => {
    assert.equal(sha256Hex('hello world'), HELLO_WORLD_SHA256)
    assert.equal(sha256Hex(Buffer.from('hello world')), HELLO_WORLD_SHA256)
  })

  test('hashLocalFile returns the digest for a real file, null when absent', () => {
    const root = tmpDir()
    try {
      const file = path.join(root, 'f.txt')
      fs.writeFileSync(file, 'hello world')
      assert.equal(hashLocalFile(file), HELLO_WORLD_SHA256)
      assert.equal(hashLocalFile(path.join(root, 'missing.txt')), null)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('decodeFileContent honors utf8 and base64 encodings', () => {
    assert.equal(decodeFileContent('hello world', 'utf8').toString('utf8'), 'hello world')
    const b64 = Buffer.from('hello world').toString('base64')
    assert.equal(decodeFileContent(b64, 'base64').toString('utf8'), 'hello world')
    // sha of the decoded bytes is stable regardless of transport encoding
    assert.equal(sha256Hex(decodeFileContent(b64, 'base64')), HELLO_WORLD_SHA256)
  })

  test('makeOriginClientId is unique and prefixed', () => {
    const a = makeOriginClientId()
    const b = makeOriginClientId()
    assert.match(a, /^cli-/)
    assert.notEqual(a, b)
  })
})

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

describe('safeResolve', () => {
  const root = path.resolve('/tmp/app-root')

  test('resolves a normal relative path inside the app dir', () => {
    assert.equal(safeResolve(root, 'config-types/indexes/validate.ts'), path.join(root, 'config-types/indexes/validate.ts'))
  })

  test('rejects traversal, absolute, UNC and empty paths', () => {
    assert.equal(safeResolve(root, '../escape.ts'), null)
    assert.equal(safeResolve(root, 'a/../../escape.ts'), null)
    assert.equal(safeResolve(root, '/etc/passwd'), null)
    assert.equal(safeResolve(root, 'C:\\Windows\\system32'), null)
    assert.equal(safeResolve(root, '\\\\server\\share'), null)
    assert.equal(safeResolve(root, ''), null)
    assert.equal(safeResolve(root, '.'), null)
    assert.equal(safeResolve(root, 'a\0b'), null)
  })
})

// ---------------------------------------------------------------------------
// Echo guard — two layers
// ---------------------------------------------------------------------------

describe('shouldIgnoreEvent (echo guard)', () => {
  const ours = 'cli-1111'

  test('layer 1: ignores events carrying our own originClientId', () => {
    const event = { path: 'a.ts', sha256: A, originClientId: ours }
    const result = shouldIgnoreEvent(event, { originClientId: ours, lastWritten: new Map() })
    assert.deepEqual(result, { ignore: true, reason: 'own-origin' })
  })

  test('layer 2: ignores events whose sha equals the hash we last wrote', () => {
    const event = { path: 'a.ts', sha256: A, originClientId: 'portal-9' }
    const lastWritten = new Map([['a.ts', A]])
    const result = shouldIgnoreEvent(event, { originClientId: ours, lastWritten })
    assert.deepEqual(result, { ignore: true, reason: 'own-hash' })
  })

  test('layer 2 also accepts a plain object as the last-written map', () => {
    const event = { path: 'a.ts', sha256: A }
    const result = shouldIgnoreEvent(event, { originClientId: ours, lastWritten: { 'a.ts': A } })
    assert.equal(result.ignore, true)
  })

  test('does NOT ignore a genuine remote edit (different origin and sha)', () => {
    const event = { path: 'a.ts', sha256: B, previousSha256: A, originClientId: 'portal-9' }
    const lastWritten = new Map([['a.ts', A]])
    const result = shouldIgnoreEvent(event, { originClientId: ours, lastWritten })
    assert.deepEqual(result, { ignore: false, reason: null })
  })

  test('a foreign origin with no known hash is not ignored', () => {
    const event = { path: 'new.ts', sha256: C, originClientId: 'portal-9' }
    const result = shouldIgnoreEvent(event, { originClientId: ours, lastWritten: new Map() })
    assert.equal(result.ignore, false)
  })
})

// ---------------------------------------------------------------------------
// Conflict rule
// ---------------------------------------------------------------------------

describe('decideApply (conflict rule)', () => {
  test('applies when local hash equals the event previousSha256', () => {
    assert.equal(decideApply({ localSha: A, previousSha256: A }), 'apply')
  })

  test('skips when local hash differs from previousSha256 (unsaved local work)', () => {
    assert.equal(decideApply({ localSha: B, previousSha256: A }), 'skip')
  })

  test('--force-pull applies regardless of mismatch', () => {
    assert.equal(decideApply({ localSha: B, previousSha256: A, forcePull: true }), 'apply')
  })

  test('a clean create (no local file, no previous) applies', () => {
    assert.equal(decideApply({ localSha: null, previousSha256: undefined }), 'apply')
    assert.equal(decideApply({ localSha: null, previousSha256: null }), 'apply')
  })

  test('a remote create that would clobber an untracked local file is skipped', () => {
    assert.equal(decideApply({ localSha: A, previousSha256: null }), 'skip')
  })
})

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

describe('atomicWrite', () => {
  test('creates parent dirs and writes the exact bytes', () => {
    const root = tmpDir()
    try {
      const target = path.join(root, 'nested/deep/file.ts')
      atomicWrite(target, Buffer.from('export const x = 1\n'))
      assert.equal(fs.readFileSync(target, 'utf8'), 'export const x = 1\n')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('atomically replaces an existing file and leaves no temp behind', () => {
    const root = tmpDir()
    try {
      const target = path.join(root, 'file.ts')
      fs.writeFileSync(target, 'old')
      atomicWrite(target, Buffer.from('new content'))
      assert.equal(fs.readFileSync(target, 'utf8'), 'new content')
      // no orphaned .veltrix-tmp-* siblings
      const leftovers = fs.readdirSync(root).filter((n) => n.startsWith('.veltrix-tmp-'))
      assert.deepEqual(leftovers, [])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Reconciliation (hash-diff)
// ---------------------------------------------------------------------------

describe('reconcile (hash-diff)', () => {
  test('pulls remote changes when local is unmodified since baseline', () => {
    const plan = reconcile({
      localEntries: [{ path: 'a.ts', sha256: A }],
      remoteEntries: [{ path: 'a.ts', sha256: B }],
      baseline: new Map([['a.ts', A]]), // local still matches what we last wrote
    })
    assert.deepEqual(plan.pull, [{ path: 'a.ts', sha256: B }])
    assert.deepEqual(plan.conflict, [])
    assert.deepEqual(plan.remove, [])
  })

  test('pulls brand-new remote files that do not exist locally', () => {
    const plan = reconcile({
      localEntries: [],
      remoteEntries: [{ path: 'new.ts', sha256: C }],
      baseline: new Map(),
    })
    assert.deepEqual(plan.pull, [{ path: 'new.ts', sha256: C }])
  })

  test('flags a conflict (skips) when BOTH sides changed since baseline', () => {
    const plan = reconcile({
      localEntries: [{ path: 'a.ts', sha256: B }], // locally edited
      remoteEntries: [{ path: 'a.ts', sha256: C }], // remotely edited
      baseline: new Map([['a.ts', A]]),
    })
    assert.deepEqual(plan.pull, [])
    assert.deepEqual(plan.conflict, [{ path: 'a.ts', reason: 'local-modified' }])
  })

  test('--force-pull overrides a conflict and pulls the remote version', () => {
    const plan = reconcile({
      localEntries: [{ path: 'a.ts', sha256: B }],
      remoteEntries: [{ path: 'a.ts', sha256: C }],
      baseline: new Map([['a.ts', A]]),
      forcePull: true,
    })
    assert.deepEqual(plan.pull, [{ path: 'a.ts', sha256: C }])
    assert.deepEqual(plan.conflict, [])
  })

  test('files already in sync produce no actions', () => {
    const plan = reconcile({
      localEntries: [{ path: 'a.ts', sha256: A }],
      remoteEntries: [{ path: 'a.ts', sha256: A }],
      baseline: new Map([['a.ts', A]]),
    })
    assert.deepEqual(plan, { pull: [], conflict: [], remove: [] })
  })

  test('removes a locally-unmodified file that was deleted in the sandbox', () => {
    const plan = reconcile({
      localEntries: [{ path: 'gone.ts', sha256: A }],
      remoteEntries: [], // no longer in the sandbox
      baseline: new Map([['gone.ts', A]]), // we synced it, unchanged locally
    })
    assert.deepEqual(plan.remove, [{ path: 'gone.ts' }])
    assert.deepEqual(plan.conflict, [])
  })

  test('keeps a locally-modified file that was deleted in the sandbox (conflict)', () => {
    const plan = reconcile({
      localEntries: [{ path: 'gone.ts', sha256: B }], // edited locally
      remoteEntries: [],
      baseline: new Map([['gone.ts', A]]),
    })
    assert.deepEqual(plan.remove, [])
    assert.deepEqual(plan.conflict, [{ path: 'gone.ts', reason: 'remote-deleted-local-modified' }])
  })

  test('a new local file not present remotely is left for the push loop (no remove)', () => {
    const plan = reconcile({
      localEntries: [{ path: 'draft.ts', sha256: A }],
      remoteEntries: [],
      baseline: new Map(), // never synced → not a remote deletion
    })
    assert.deepEqual(plan, { pull: [], conflict: [], remove: [] })
  })

  test('accepts a plain object as the baseline', () => {
    const plan = reconcile({
      localEntries: [{ path: 'a.ts', sha256: A }],
      remoteEntries: [{ path: 'a.ts', sha256: B }],
      baseline: { 'a.ts': A },
    })
    assert.deepEqual(plan.pull, [{ path: 'a.ts', sha256: B }])
  })
})
