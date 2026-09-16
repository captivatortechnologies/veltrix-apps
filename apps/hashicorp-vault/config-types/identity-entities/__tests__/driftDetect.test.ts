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

function ctx(fields: Record<string, unknown>, o: { token?: string | null } = {}) {
  return makeDriftContext(makeCanvas([{ name: 'Entity 1', fields }], 'identity-entities'), o)
}

const DECLARED = {
  name: 'app-svc',
  policies: ['app-read', 'ops'],
  metadataJson: '{"team":"platform"}',
}

function liveEntity(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      data: {
        id: 'e-1',
        name: 'app-svc',
        policies: ['app-read', 'ops'],
        metadata: { team: 'platform' },
        disabled: false,
        ...overrides,
      },
    },
  }
}

describe('Vault Identity Entities Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(DECLARED, { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live entity matches', async () => {
    const fetchStub = recordFetch([liveEntity()])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/entity/name/app-svc`)
    } finally {
      fetchStub.restore()
    }
  })

  it('compares policies as a set — a different order is not drift', async () => {
    const fetchStub = recordFetch([liveEntity({ policies: ['ops', 'app-read'] })])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores the server-computed fields Vault maintains itself', async () => {
    const fetchStub = recordFetch([
      liveEntity({
        id: 'a-completely-different-id',
        aliases: [{ id: 'alias-9' }],
        group_ids: ['grp-7'],
        direct_group_ids: ['grp-7'],
        last_update_time: '2030-01-01T00:00:00Z',
      }),
    ])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an entity deleted out of band as critical drift', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('app-svc')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a policy attachment added out of band as a warning naming the field', async () => {
    const fetchStub = recordFetch([liveEntity({ policies: ['app-read', 'ops', 'admin'] })])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('app-svc.policies')
      expect(result.diffs[0].severity).toBe('warning')
      expect(String(result.diffs[0].actual)).toMatch(/admin/)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an entity disabled out of band', async () => {
    const fetchStub = recordFetch([liveEntity({ disabled: true })])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('app-svc.disabled')
      expect(result.diffs[0].expected).toBe('false')
      expect(result.diffs[0].actual).toBe('true')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags changed metadata as informational only', async () => {
    const fetchStub = recordFetch([liveEntity({ metadata: { team: 'infra' } })])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('app-svc.metadata')
      expect(result.diffs[0].severity).toBe('info')
      expect(result.diffs[0].expected).toBe('team=platform')
      expect(result.diffs[0].actual).toBe('team=infra')
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes a numeric metadata value so a stringified match is not drift', async () => {
    const fetchStub = recordFetch([liveEntity({ metadata: { tier: 1 } })])
    try {
      const result = await driftDetect(ctx({ ...DECLARED, metadataJson: '{"tier":"1"}' }))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('app-svc')
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining entities after one errors', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Entity 1', fields: { name: 'first' } },
        { name: 'Entity 2', fields: { name: 'second' } },
      ],
      'identity-entities',
    )
    const fetchStub = recordFetch([FORBIDDEN, { status: 200, body: { data: { name: 'second' } } }])
    try {
      const result = await driftDetect(makeDriftContext(canvas))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
