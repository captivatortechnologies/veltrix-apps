import type { RemoteExecutor } from '@veltrixsecops/app-sdk'
import { expectedAppFiles, detectManagedContentDrift, detectRestConfigDrift } from '../contentDrift'
import { __setSplunkTransport } from '../../../lib/splunkApi'

// =============================================================================
// Content drift — the files a deploy shipped vs the live app.
// =============================================================================

const inlineFields = {
  name: 'my_ta',
  source: 'inline',
  appFiles: [{ path: 'default/inputs.conf', content: '[monitor:///var/log/app.log]\nindex = main' }],
}

const OPTS = { build: 1, configName: 'my_ta' }

/** RemoteExecutor stub: canned hashTree + readFile. */
function remoteStub(hashTree: Array<{ path: string; sha256: string }>, read: Record<string, string> = {}): RemoteExecutor {
  return {
    homeDir: '/opt/splunk',
    hashTree: async () => hashTree,
    readFile: async (p: string) => read[p] ?? '',
    extractArchive: async () => {},
    putFile: async () => {},
    run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
  } as unknown as RemoteExecutor
}

describe('expectedAppFiles', () => {
  it('hashes every shipped file, relative to the app dir, incl. generated files', () => {
    const files = expectedAppFiles(inlineFields, OPTS)
    const paths = files.map((f) => f.rel)
    expect(paths).toContain('default/inputs.conf')
    expect(paths).toContain('default/app.conf') // generated from identity
    expect(paths).toContain('metadata/default.meta') // generated
    for (const f of files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    // No leading app-id segment on the relative paths.
    expect(paths.some((p) => p.startsWith('my_ta/'))).toBe(false)
  })
})

describe('detectManagedContentDrift', () => {
  const expected = expectedAppFiles(inlineFields, OPTS)
  const asLive = (files = expected) => files.map((e) => ({ path: e.rel, sha256: e.sha256 }))

  it('no drift when every shipped file matches', async () => {
    const diffs = await detectManagedContentDrift(remoteStub(asLive()), 'my_ta', expected)
    expect(diffs).toHaveLength(0)
  })

  it('reports a modified file AND pulls the live content so the diff is visible', async () => {
    const liveText = '[monitor:///var/log/app.log]\nindex = CHANGED'
    const live = expected.map((e) =>
      e.rel === 'default/inputs.conf' ? { path: e.rel, sha256: 'd'.repeat(64) } : { path: e.rel, sha256: e.sha256 },
    )
    const diffs = await detectManagedContentDrift(
      remoteStub(live, { '/opt/splunk/etc/apps/my_ta/default/inputs.conf': liveText }),
      'my_ta',
      expected,
    )
    const d = diffs.find((x) => x.field === 'my_ta/default/inputs.conf')
    expect(d).toBeDefined()
    expect(d?.severity).toBe('warning')
    expect(String(d?.expected)).toContain('index = main')
    expect(String(d?.actual)).toContain('index = CHANGED')
  })

  it('reports a shipped file that is missing on the target', async () => {
    const live = asLive(expected.filter((e) => e.rel !== 'default/inputs.conf'))
    const diffs = await detectManagedContentDrift(remoteStub(live), 'my_ta', expected)
    expect(diffs.some((d) => d.field === 'my_ta/default/inputs.conf' && d.actual === 'missing on the target')).toBe(true)
  })

  it('reports an unexpected file added under default/', async () => {
    const live = [...asLive(), { path: 'default/rogue.conf', sha256: 'a'.repeat(64) }]
    const diffs = await detectManagedContentDrift(remoteStub(live), 'my_ta', expected)
    expect(diffs.some((d) => d.field === 'my_ta/default/rogue.conf' && d.severity === 'info')).toBe(true)
  })

  it('does NOT flag extra files outside default/ (local overrides, runtime files)', async () => {
    const live = [...asLive(), { path: 'local/inputs.conf', sha256: 'b'.repeat(64) }, { path: 'metadata/local.meta', sha256: 'c'.repeat(64) }]
    const diffs = await detectManagedContentDrift(remoteStub(live), 'my_ta', expected)
    expect(diffs.some((d) => d.field.includes('local/'))).toBe(false)
  })

  it('returns nothing when the app dir is empty (the app-state check reports missing)', async () => {
    const diffs = await detectManagedContentDrift(remoteStub([]), 'my_ta', expected)
    expect(diffs).toHaveLength(0)
  })
})

describe('detectRestConfigDrift (non-managed)', () => {
  const effective = (content: Record<string, unknown>) => async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ entry: [{ name: 'monitor:///var/log/app.log', content }] }),
  })

  it('flags a shipped stanza key whose effective value changed', async () => {
    __setSplunkTransport(effective({ index: 'prod' }))
    try {
      const diffs = await detectRestConfigDrift('https://x:8089', {}, 'my_ta', inlineFields)
      const d = diffs.find((x) => x.field.includes('inputs.conf') && x.field.endsWith('/index'))
      expect(d).toBeDefined()
      expect(d?.expected).toBe('main')
      expect(String(d?.actual)).toBe('prod')
    } finally {
      __setSplunkTransport(null)
    }
  })

  it('no drift when effective values match shipped', async () => {
    __setSplunkTransport(effective({ index: 'main' }))
    try {
      const diffs = await detectRestConfigDrift('https://x:8089', {}, 'my_ta', inlineFields)
      expect(diffs).toHaveLength(0)
    } finally {
      __setSplunkTransport(null)
    }
  })

  it('flags a shipped stanza that is absent from the effective config', async () => {
    __setSplunkTransport(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ entry: [] }) }))
    try {
      const diffs = await detectRestConfigDrift('https://x:8089', {}, 'my_ta', inlineFields)
      expect(diffs.some((d) => d.field.includes('[monitor:///var/log/app.log]') && d.actual === 'missing')).toBe(true)
    } finally {
      __setSplunkTransport(null)
    }
  })
})
