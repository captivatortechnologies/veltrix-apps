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

const AUTHORED = { name: 'kv-reads', path: 'secret/', rate: 1000, interval: '1s', blockInterval: '0s' }

function ctx(fields: Record<string, unknown> = AUTHORED, o: { token?: string | null } = {}) {
  return makeDriftContext(makeCanvas([{ name: 'Quota 1', fields }], 'rate-limit-quotas'), o)
}

function live(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

const MATCHING = { type: 'rate-limit', name: 'kv-reads', path: 'secret/', rate: 1000, interval: 1, block_interval: 0 }

describe('Vault Rate Limit Quotas Drift Detect Handler', () => {
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
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/quotas/rate-limit/kv-reads`)
      expect(fetchStub.calls[0].method).toBe('GET')
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores the duration-vs-seconds representation gap', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, interval: 60, block_interval: 90 })])
    try {
      // "1m" and 60 seconds are the same interval — a cosmetic difference only.
      const result = await driftDetect(ctx({ ...AUTHORED, interval: '1m', blockInterval: '1m30s' }))

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

  it('flags a changed rate with both numeric values', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, rate: 5 })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('kv-reads.rate')
      expect(result.diffs[0].expected).toBe('1000')
      expect(result.diffs[0].actual).toBe('5')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a re-scoped path', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, path: 'auth/' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('kv-reads.path')
      expect(result.diffs[0].expected).toBe('secret/')
      expect(result.diffs[0].actual).toBe('auth/')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a global limiter that has been silently scoped to a path', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, path: 'secret/' })])
    try {
      const result = await driftDetect(ctx({ name: 'kv-reads', path: '', rate: 1000 }))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('kv-reads.path')
      expect(String(result.diffs[0].expected)).toMatch(/global/)
      expect(result.diffs[0].actual).toBe('secret/')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a changed block interval in seconds', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, block_interval: 300 })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('kv-reads.blockInterval')
      expect(result.diffs[0].actual).toBe('300s')
    } finally {
      fetchStub.restore()
    }
  })

  it('does not compare an interval or role the canvas does not manage', async () => {
    const fetchStub = recordFetch([live({ ...MATCHING, interval: 3600, block_interval: 60, role: 'ci' })])
    try {
      const result = await driftDetect(ctx({ name: 'kv-reads', path: 'secret/', rate: 1000 }))

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
      expect(result.diffs[0].field).toBe('kv-reads.role')
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
      expect(result.diffs[0].field).toBe('kv-reads')
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
        { name: 'Quota 1', fields: { name: 'first', path: 'secret/', rate: 10 } },
        { name: 'Quota 2', fields: { name: 'second', path: 'secret/', rate: 20 } },
      ],
      'rate-limit-quotas',
    )
    const fetchStub = recordFetch([FORBIDDEN, live({ name: 'second', path: 'secret/', rate: 20 })])
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
