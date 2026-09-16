import driftDetect from '../driftDetect'
import type { LiveTransitKey } from '../validate'
import {
  FORBIDDEN,
  NOT_FOUND,
  VAULT_BASE,
  assertNoTokenLeak,
  makeCanvas,
  makeDriftContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const AES = 'aes256-gcm96'

function liveKey(data: LiveTransitKey) {
  return { status: 200, body: { data } }
}

function ctx(
  keys: Array<Record<string, unknown>> = [{ mount: 'transit', name: 'app', type: AES }],
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeDriftContext(
    makeCanvas(
      keys.map((fields, i) => ({ name: `Key ${i + 1}`, fields })),
      'transit-keys',
    ),
    o,
  )
}

describe('Vault Transit Keys Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(undefined, { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(undefined, { hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live key matches', async () => {
    const fetchStub = recordFetch([liveKey({ type: AES })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/transit/keys/app`)
    } finally {
      fetchStub.restore()
    }
  })

  it('folds the live key type case rather than calling it drift', async () => {
    const fetchStub = recordFetch([liveKey({ type: 'AES256-GCM96' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes a rotation duration against the seconds Vault echoes back', async () => {
    const fetchStub = recordFetch([liveKey({ type: AES, auto_rotate_period: 86400 })])
    try {
      const result = await driftDetect(
        ctx([{ mount: 'transit', name: 'app', type: AES, autoRotatePeriod: '24h' }]),
      )

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a key that has been deleted out of band as critical', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('transit/app')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a recreated key of a different type as critical', async () => {
    const fetchStub = recordFetch([liveKey({ type: 'rsa-4096' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('transit/app.type')
      expect(result.diffs[0].actual).toBe('rsa-4096')
      expect(String(result.diffs[0].expected)).toMatch(/immutable/)
      expect(String(result.diffs[0].expected)).toMatch(/recreated with different material/)
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an un-revertable exportable key as critical', async () => {
    const fetchStub = recordFetch([liveKey({ type: AES, exportable: true })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('transit/app.exportable')
      expect(result.diffs[0].actual).toBe('true')
      expect(String(result.diffs[0].expected)).toMatch(/UNFIXABLE/)
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an un-revertable plaintext-backup key as critical', async () => {
    const fetchStub = recordFetch([liveKey({ type: AES, allow_plaintext_backup: true })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs[0].field).toBe('transit/app.allowPlaintextBackup')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a write-once flag the next deploy can still set as a warning', async () => {
    const fetchStub = recordFetch([liveKey({ type: AES, exportable: false })])
    try {
      const result = await driftDetect(
        ctx([{ mount: 'transit', name: 'app', type: AES, exportable: true }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('transit/app.exportable')
      expect(result.diffs[0].expected).toBe('true')
      expect(result.diffs[0].actual).toBe('false')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a key that was made deletable out of band', async () => {
    const fetchStub = recordFetch([liveKey({ type: AES, deletion_allowed: true })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('transit/app.deletionAllowed')
      expect(result.diffs[0].expected).toBe('false')
      expect(result.diffs[0].actual).toBe('true')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('compares only the version bounds the canvas manages', async () => {
    const fetchStub = recordFetch([
      liveKey({ type: AES, min_decryption_version: 1, min_encryption_version: 5 }),
    ])
    try {
      const result = await driftDetect(
        ctx([{ mount: 'transit', name: 'app', type: AES, minDecryptionVersion: 2 }]),
      )

      expect(result.hasDrift).toBe(true)
      // min_encryption_version is unmanaged here, so its live value is not drift.
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('transit/app.minDecryptionVersion')
      expect(result.diffs[0].expected).toBe('2')
      expect(result.diffs[0].actual).toBe('1')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('names a drifted rotation period and shows both sides in seconds', async () => {
    const fetchStub = recordFetch([liveKey({ type: AES, auto_rotate_period: 3600 })])
    try {
      const result = await driftDetect(
        ctx([{ mount: 'transit', name: 'app', type: AES, autoRotatePeriod: '24h' }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('transit/app.autoRotatePeriod')
      expect(result.diffs[0].expected).toBe('24h (86400s)')
      expect(result.diffs[0].actual).toBe('3600s')
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('transit/app')
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(String(result.diffs[0].actual)).toMatch(/permission denied/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining keys after one errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN, liveKey({ type: AES })])
    try {
      const result = await driftDetect(
        ctx([
          { mount: 'transit', name: 'app', type: AES },
          { mount: 'transit', name: 'db', type: AES },
        ]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('transit/app')
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
