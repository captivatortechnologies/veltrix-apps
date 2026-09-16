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

const DECLARED = {
  name: 'platform-admins',
  type: 'internal',
  policies: ['ops', 'admin'],
  memberEntityIds: ['e-1', 'e-2'],
  memberGroupIds: [],
}

function ctx(fields: Record<string, unknown>, o: { token?: string | null } = {}) {
  return makeDriftContext(makeCanvas([{ name: 'Group 1', fields }], 'identity-groups'), o)
}

function liveGroup(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      data: {
        id: 'g-1',
        name: 'platform-admins',
        type: 'internal',
        policies: ['ops', 'admin'],
        member_entity_ids: ['e-1', 'e-2'],
        member_group_ids: [],
        metadata: { owner: 'platform' },
        ...overrides,
      },
    },
  }
}

describe('Vault Identity Groups Drift Detect Handler', () => {
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

  it('reports no drift when the live group matches', async () => {
    const fetchStub = recordFetch([liveGroup()])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/group/name/platform-admins`)
    } finally {
      fetchStub.restore()
    }
  })

  it('compares policies and members as sets — a different order is not drift', async () => {
    const fetchStub = recordFetch([
      liveGroup({ policies: ['admin', 'ops'], member_entity_ids: ['e-2', 'e-1'] }),
    ])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a group deleted out of band as critical drift', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('platform-admins')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a changed type as critical and says it cannot be fixed in place', async () => {
    const fetchStub = recordFetch([liveGroup({ type: 'external' })])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('platform-admins.type')
      expect(result.diffs[0].severity).toBe('critical')
      expect(String(result.diffs[0].expected)).toMatch(/immutable/)
      expect(result.diffs[0].actual).toBe('external')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a policy attached out of band as a warning naming the field', async () => {
    const fetchStub = recordFetch([liveGroup({ policies: ['ops', 'admin', 'root-ish'] })])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('platform-admins.policies')
      expect(result.diffs[0].severity).toBe('warning')
      expect(String(result.diffs[0].actual)).toMatch(/root-ish/)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags internal membership changes on both member lists', async () => {
    const fetchStub = recordFetch([liveGroup({ member_entity_ids: ['e-1'], member_group_ids: ['g-9'] })])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(2)
      expect(result.diffs[0].field).toBe('platform-admins.member_entity_ids')
      expect(result.diffs[1].field).toBe('platform-admins.member_group_ids')
      expect(result.diffs[1].expected).toBe('none')
      expect(result.diffs[1].actual).toBe('g-9')
    } finally {
      fetchStub.restore()
    }
  })

  it('never diffs the membership of an external group — Vault owns it via group-aliases', async () => {
    const fetchStub = recordFetch([
      liveGroup({ type: 'external', member_entity_ids: ['auto-1'], member_group_ids: ['auto-2'] }),
    ])
    try {
      const result = await driftDetect(ctx({ ...DECLARED, name: 'platform-admins', type: 'external' }))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('does not treat metadata as a drift signal', async () => {
    const fetchStub = recordFetch([liveGroup({ metadata: { owner: 'someone-else' } })])
    try {
      const result = await driftDetect(ctx({ ...DECLARED, metadataJson: '{"owner":"platform"}' }))

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
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining groups after one errors', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Group 1', fields: { name: 'first', type: 'internal' } },
        { name: 'Group 2', fields: { name: 'second', type: 'internal' } },
      ],
      'identity-groups',
    )
    const fetchStub = recordFetch([
      FORBIDDEN,
      { status: 200, body: { data: { name: 'second', type: 'internal', policies: [] } } },
    ])
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
