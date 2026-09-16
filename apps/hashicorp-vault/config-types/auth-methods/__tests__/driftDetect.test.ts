import driftDetect from '../driftDetect'
import type { LiveAuthMethod } from '../validate'
import {
  FORBIDDEN,
  NOT_FOUND,
  VAULT_BASE,
  assertNoTokenLeak,
  makeCanvas,
  makeDriftContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const USERPASS_ENABLED = { status: 200, body: { data: { 'userpass/': { type: 'userpass' } } } }

function liveMethods(map: Record<string, LiveAuthMethod>) {
  return { status: 200, body: { data: map } }
}

function tune(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

function ctx(
  methods: Array<Record<string, unknown>> = [{ path: 'userpass', type: 'userpass' }],
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeDriftContext(
    makeCanvas(
      methods.map((fields, i) => ({ name: `Method ${i + 1}`, fields })),
      'auth-methods',
    ),
    o,
  )
}

describe('Vault Auth Methods Drift Detect Handler', () => {
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

  it('reports no drift and calls nothing when the canvas declares no method', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx([]))

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live mount and its tuning match', async () => {
    const fetchStub = recordFetch([USERPASS_ENABLED, tune({ default_lease_ttl: 2764800, description: '' })])
    try {
      const result = await driftDetect(ctx([{ path: 'userpass', type: 'userpass', defaultLeaseTtl: '768h' }]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/auth`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/auth/userpass/tune`)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes a duration TTL against the seconds Vault echoes back', async () => {
    const fetchStub = recordFetch([USERPASS_ENABLED, tune({ max_lease_ttl: 31536000, description: '' })])
    try {
      // "8760h" and 31536000 are the same TTL — a unit difference is not drift.
      const result = await driftDetect(ctx([{ path: 'userpass', type: 'userpass', maxLeaseTtl: '8760h' }]))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores surrounding whitespace on the live description', async () => {
    const fetchStub = recordFetch([USERPASS_ENABLED, tune({ description: '  Local users  ' })])
    try {
      const result = await driftDetect(
        ctx([{ path: 'userpass', type: 'userpass', description: 'Local users' }]),
      )

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a mount that has been disabled out of band as critical', async () => {
    const fetchStub = recordFetch([liveMethods({ 'approle/': { type: 'approle' } })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('userpass')
      expect(result.diffs[0].expected).toBe('enabled')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
      // A missing mount has no tuning to read.
      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a different auth backend at the managed path as critical and stops comparing it', async () => {
    const fetchStub = recordFetch([liveMethods({ 'userpass/': { type: 'ldap' } })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('userpass.type')
      expect(result.diffs[0].expected).toBe('userpass')
      expect(result.diffs[0].actual).toBe('ldap')
      expect(result.diffs[0].severity).toBe('critical')
      // Tuning of a different backend is meaningless, so it is not read.
      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('names the tune field that changed', async () => {
    const fetchStub = recordFetch([
      USERPASS_ENABLED,
      tune({ token_type: 'service', listing_visibility: 'hidden', description: '' }),
    ])
    try {
      const result = await driftDetect(
        ctx([{ path: 'userpass', type: 'userpass', tokenType: 'batch', listingVisibility: 'unauth' }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(2)
      expect(result.diffs[0].field).toBe('userpass.tokenType')
      expect(result.diffs[0].expected).toBe('batch')
      expect(result.diffs[0].actual).toBe('service')
      expect(result.diffs[0].severity).toBe('warning')
      expect(result.diffs[1].field).toBe('userpass.listingVisibility')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a managed TTL that the mount no longer carries', async () => {
    const fetchStub = recordFetch([USERPASS_ENABLED, NOT_FOUND])
    try {
      const result = await driftDetect(
        ctx([{ path: 'userpass', type: 'userpass', defaultLeaseTtl: '768h' }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('userpass.defaultLeaseTtl')
      expect(result.diffs[0].expected).toBe('2764800s')
      expect(result.diffs[0].actual).toBe('not set')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff per managed path rather than throwing when the list fails', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(
        ctx([
          { path: 'userpass', type: 'userpass' },
          { path: 'approle', type: 'approle' },
        ]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(2)
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(String(result.diffs[1].actual)).toMatch(/permission denied/)
      expect(fetchStub.calls).toHaveLength(1)
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining methods after one tuning read errors', async () => {
    const fetchStub = recordFetch([
      liveMethods({ 'userpass/': { type: 'userpass' }, 'approle/': { type: 'approle' } }),
      FORBIDDEN,
      tune({ description: '' }),
    ])
    try {
      const result = await driftDetect(
        ctx([
          { path: 'userpass', type: 'userpass' },
          { path: 'approle', type: 'approle' },
        ]),
      )

      expect(result.hasDrift).toBe(true)
      // Only the first drifted; the second was still read and matched.
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('userpass')
      expect(fetchStub.calls).toHaveLength(3)
    } finally {
      fetchStub.restore()
    }
  })
})
