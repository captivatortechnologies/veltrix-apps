import driftDetect from '../driftDetect'
import {
  FORBIDDEN,
  NOT_FOUND,
  VAULT_BASE,
  assertNoTokenLeak,
  makeCanvas,
  makeDriftContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const SHA_A = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const SHA_B = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'

const AUTHORED = { type: 'secret', name: 'acme-kv', sha256: SHA_A, command: 'acme-kv' }

const MATCHING = { name: 'acme-kv', sha256: SHA_A, command: 'acme-kv', args: [], builtin: false }

function ctx(fields: Record<string, unknown> = AUTHORED, o: { token?: string | null } = {}) {
  return makeDriftContext(makeCanvas([{ name: 'Plugin 1', fields }], 'plugins'), o)
}

function live(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

describe('Vault Plugin Catalog Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(AUTHORED, { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live catalog entry matches', async () => {
    const fetchStub = recordFetch([live(MATCHING)])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/plugins/catalog/secret/acme-kv`)
      expect(fetchStub.calls[0].method).toBe('GET')
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores the case of the digest Vault echoes back', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, sha256: SHA_A.toUpperCase() })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('never reports drift on env, which Vault does not return', async () => {
    const fetchStub = recordFetch([live(MATCHING)])
    try {
      const result = await driftDetect(ctx({ ...AUTHORED, envJson: '["API_HOST=example.com"]' }))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a re-registered binary digest', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, sha256: SHA_B })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret/acme-kv.sha256')
      expect(result.diffs[0].expected).toBe(SHA_A)
      expect(result.diffs[0].actual).toBe(SHA_B)
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a swapped executable', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, command: 'evil-kv' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret/acme-kv.command')
      expect(result.diffs[0].expected).toBe('acme-kv')
      expect(result.diffs[0].actual).toBe('evil-kv')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags args added out of band', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, args: ['--debug'] })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret/acme-kv.args')
      expect(result.diffs[0].expected).toBe('[]')
      expect(result.diffs[0].actual).toBe('["--debug"]')
    } finally {
      fetchStub.restore()
    }
  })

  it('treats reordered args as drift — argument order is significant', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, args: ['--b', '--a'] })])
    try {
      const result = await driftDetect(ctx({ ...AUTHORED, argsJson: '["--a","--b"]' }))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('secret/acme-kv.args')
    } finally {
      fetchStub.restore()
    }
  })

  it('does not compare a version the canvas does not manage', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, version: 'v9.9.9' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a changed version when the canvas manages it', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, version: 'v1.0.0' })])
    try {
      const result = await driftDetect(ctx({ ...AUTHORED, version: 'v1.2.0' }))

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret/acme-kv.version')
      expect(result.diffs[0].expected).toBe('v1.2.0')
      expect(result.diffs[0].actual).toBe('v1.0.0')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a managed plugin that has been deregistered out of band', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret/acme-kv')
      expect(result.diffs[0].expected).toBe('registered')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('secret/acme-kv')
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining plugins after one errors', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Plugin 1', fields: { ...AUTHORED, name: 'first' } },
        { name: 'Plugin 2', fields: { ...AUTHORED, name: 'second' } },
      ],
      'plugins',
    )
    const fetchStub = recordFetch([
      FORBIDDEN,
      live({ name: 'second', sha256: SHA_A, command: 'acme-kv', args: [] }),
    ])
    try {
      const result = await driftDetect(makeDriftContext(canvas))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret/first')
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
