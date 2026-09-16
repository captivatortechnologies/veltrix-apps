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

const AUTHORED = { name: 'db-leases', path: 'database/', maxLeases: 1000 }

const MATCHING = {
  type: 'lease-count',
  name: 'db-leases',
  path: 'database/',
  max_leases: 1000,
  inheritable: false,
}

function ctx(fields: Record<string, unknown> = AUTHORED, o: { token?: string | null } = {}) {
  return makeDriftContext(makeCanvas([{ name: 'Quota 1', fields }], 'lease-count-quotas'), o)
}

function live(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

describe('Vault Lease Count Quotas Drift Detect Handler', () => {
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

  it('reports no drift when the live quota matches', async () => {
    const fetchStub = recordFetch([live(MATCHING)])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/quotas/lease-count/db-leases`)
      expect(fetchStub.calls[0].method).toBe('GET')
    } finally {
      fetchStub.restore()
    }
  })

  it('treats an omitted inheritable flag as false rather than drift', async () => {
    const fetchStub = recordFetch([live({ type: 'lease-count', name: 'db-leases', path: 'database/', max_leases: 1000 })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores the server-computed type field', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, type: 'something-else' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a changed lease cap with both numeric values', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, max_leases: 5 })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('db-leases.maxLeases')
      expect(result.diffs[0].expected).toBe('1000')
      expect(result.diffs[0].actual).toBe('5')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a re-scoped path', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, path: 'secret/' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('db-leases.path')
      expect(result.diffs[0].expected).toBe('database/')
      expect(result.diffs[0].actual).toBe('secret/')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a global limiter that has been silently scoped to a path', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, path: 'database/' })])
    try {
      const result = await driftDetect(ctx({ name: 'db-leases', path: '', maxLeases: 1000 }))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('db-leases.path')
      expect(String(result.diffs[0].expected)).toMatch(/global/)
      expect(result.diffs[0].actual).toBe('database/')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an inheritable flag turned on out of band', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, inheritable: true })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('db-leases.inheritable')
      expect(result.diffs[0].expected).toBe('false')
      expect(result.diffs[0].actual).toBe('true')
    } finally {
      fetchStub.restore()
    }
  })

  it('does not compare a role the canvas does not manage', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, role: 'ci' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a changed role when the canvas manages it', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, role: 'other' })])
    try {
      const result = await driftDetect(ctx({ ...AUTHORED, role: 'ci' }))

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('db-leases.role')
      expect(result.diffs[0].expected).toBe('ci')
      expect(result.diffs[0].actual).toBe('other')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a managed quota that has been deleted out of band', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('db-leases')
      expect(result.diffs[0].expected).toBe('present')
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
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining quotas after one errors', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Quota 1', fields: { name: 'first', path: 'database/', maxLeases: 10 } },
        { name: 'Quota 2', fields: { name: 'second', path: 'database/', maxLeases: 20 } },
      ],
      'lease-count-quotas',
    )
    const fetchStub = recordFetch([
      FORBIDDEN,
      live({ name: 'second', path: 'database/', max_leases: 20, inheritable: false }),
    ])
    try {
      const result = await driftDetect(makeDriftContext(canvas))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('first')
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
