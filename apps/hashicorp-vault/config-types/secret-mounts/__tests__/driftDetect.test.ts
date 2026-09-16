import driftDetect from '../driftDetect'
import type { LiveMount } from '../validate'
import {
  FORBIDDEN,
  VAULT_BASE,
  assertNoTokenLeak,
  makeCanvas,
  makeDriftContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

function liveMounts(map: Record<string, LiveMount>) {
  return { status: 200, body: { data: map } }
}

const SECRET_MOUNTED = liveMounts({ 'secret/': { type: 'kv' } })

function tune(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

function ctx(
  mounts: Array<Record<string, unknown>> = [{ path: 'secret', type: 'kv' }],
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeDriftContext(
    makeCanvas(
      mounts.map((fields, i) => ({ name: `Engine ${i + 1}`, fields })),
      'secret-mounts',
    ),
    o,
  )
}

describe('Vault Secret Mounts Drift Detect Handler', () => {
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

  it('reports no drift when the live mount matches and reads no tuning it does not need', async () => {
    const fetchStub = recordFetch([SECRET_MOUNTED])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/mounts`)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes a duration TTL against the seconds Vault echoes back', async () => {
    const fetchStub = recordFetch([SECRET_MOUNTED, tune({ default_lease_ttl: 2764800 })])
    try {
      const result = await driftDetect(
        ctx([{ path: 'secret', type: 'kv', defaultLeaseTtl: '768h' }]),
      )

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/mounts/secret/tune`)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes a TTL Vault returns as a numeric string', async () => {
    const fetchStub = recordFetch([SECRET_MOUNTED, tune({ default_lease_ttl: '2764800' })])
    try {
      const result = await driftDetect(
        ctx([{ path: 'secret', type: 'kv', defaultLeaseTtl: '768h' }]),
      )

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an engine that has been unmounted out of band as critical', async () => {
    const fetchStub = recordFetch([liveMounts({ 'other/': { type: 'kv' } })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret')
      expect(result.diffs[0].expected).toBe('mounted')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a different engine at the managed path as critical', async () => {
    const fetchStub = recordFetch([liveMounts({ 'secret/': { type: 'transit' } })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('secret.type')
      expect(result.diffs[0].expected).toBe('kv')
      expect(result.diffs[0].actual).toBe('transit')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a KV version mismatch as critical and says a redeploy cannot fix it', async () => {
    const fetchStub = recordFetch([liveMounts({ 'secret/': { type: 'kv', options: { version: '1' } } })])
    try {
      const result = await driftDetect(ctx([{ path: 'secret', type: 'kv', kvVersion: '2' }]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret.options.version')
      expect(result.diffs[0].actual).toBe('1')
      expect(String(result.diffs[0].expected)).toMatch(/immutable/)
      expect(String(result.diffs[0].expected)).toMatch(/destroys its data/)
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a description change as informational, not as a failure', async () => {
    const fetchStub = recordFetch([liveMounts({ 'secret/': { type: 'kv', description: 'set by hand' } })])
    try {
      const result = await driftDetect(ctx([{ path: 'secret', type: 'kv', description: 'Managed' }]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret.description')
      expect(result.diffs[0].expected).toBe('Managed')
      expect(result.diffs[0].actual).toBe('set by hand')
      expect(result.diffs[0].severity).toBe('info')
    } finally {
      fetchStub.restore()
    }
  })

  it('names the TTL that drifted and shows both sides in seconds', async () => {
    const fetchStub = recordFetch([SECRET_MOUNTED, tune({ default_lease_ttl: 3600 })])
    try {
      const result = await driftDetect(
        ctx([{ path: 'secret', type: 'kv', defaultLeaseTtl: '768h' }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret.defaultLeaseTtl')
      expect(result.diffs[0].expected).toBe('768h (2764800s)')
      expect(result.diffs[0].actual).toBe('3600s')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('secret')
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(String(result.diffs[0].actual)).toMatch(/permission denied/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining engines after one errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN, liveMounts({ 'transit/': { type: 'transit' } })])
    try {
      const result = await driftDetect(
        ctx([
          { path: 'secret', type: 'kv' },
          { path: 'transit', type: 'transit' },
        ]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('secret')
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
