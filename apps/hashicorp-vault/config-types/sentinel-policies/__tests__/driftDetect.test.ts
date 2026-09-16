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

const SENTINEL = 'main = rule {\n  identity.entity.metadata.role is "admin"\n}'
const RGP = { scope: 'rgp', name: 'require-admin', policy: SENTINEL, enforcementLevel: 'advisory' }
const EGP = {
  scope: 'egp',
  name: 'guard-secrets',
  policy: SENTINEL,
  enforcementLevel: 'hard-mandatory',
  paths: ['secret/*', 'kv/*'],
}

function ctx(policies: Array<Record<string, unknown>> = [RGP], o: { token?: string | null } = {}) {
  return makeDriftContext(
    makeCanvas(
      policies.map((fields, i) => ({ name: `Policy ${i + 1}`, fields })),
      'sentinel-policies',
    ),
    o,
  )
}

function live(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

describe('Vault Sentinel Policies Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx([RGP], { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live policy matches', async () => {
    const fetchStub = recordFetch([live({ policy: SENTINEL, enforcement_level: 'advisory' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/rgp/require-admin`)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores a cosmetic reformat — comments and whitespace are not drift', async () => {
    const reformatted =
      '# owned by platform team\nmain   =   rule {\n\n   identity.entity.metadata.role is "admin"\n\n}\n'
    const fetchStub = recordFetch([live({ policy: reformatted, enforcement_level: 'advisory' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a rewritten policy body', async () => {
    const fetchStub = recordFetch([
      live({ policy: 'main = rule { false }', enforcement_level: 'advisory' }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('rgp/require-admin.policy')
      expect(result.diffs[0].severity).toBe('warning')
      expect(String(result.diffs[0].actual)).toMatch(/false/)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a weakened enforcement level', async () => {
    const fetchStub = recordFetch([
      live({ policy: SENTINEL, enforcement_level: 'soft-mandatory' }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('rgp/require-admin.enforcementLevel')
      expect(result.diffs[0].expected).toBe('advisory')
      expect(result.diffs[0].actual).toBe('soft-mandatory')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports an absent enforcement level as "not set"', async () => {
    const fetchStub = recordFetch([live({ policy: SENTINEL })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs[0].actual).toBe('not set')
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores the order of EGP paths', async () => {
    const fetchStub = recordFetch([
      live({ policy: SENTINEL, enforcement_level: 'hard-mandatory', paths: ['kv/*', 'secret/*'] }),
    ])
    try {
      const result = await driftDetect(ctx([EGP]))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an EGP whose guarded paths changed', async () => {
    const fetchStub = recordFetch([
      live({ policy: SENTINEL, enforcement_level: 'hard-mandatory', paths: ['secret/*'] }),
    ])
    try {
      const result = await driftDetect(ctx([EGP]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('egp/guard-secrets.paths')
      expect(result.diffs[0].expected).toBe('kv/*,secret/*')
      expect(result.diffs[0].actual).toBe('secret/*')
    } finally {
      fetchStub.restore()
    }
  })

  it('never diffs paths for an RGP, even when Vault returns some', async () => {
    const fetchStub = recordFetch([
      live({ policy: SENTINEL, enforcement_level: 'advisory', paths: ['stray/*'] }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a policy deleted out of band as critical', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('rgp/require-admin')
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

  it('keeps checking the remaining policies after one errors', async () => {
    const fetchStub = recordFetch([
      FORBIDDEN,
      live({ policy: SENTINEL, enforcement_level: 'advisory' }),
    ])
    try {
      const result = await driftDetect(ctx([{ ...RGP, name: 'first' }, { ...RGP, name: 'second' }]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(fetchStub.calls).toHaveLength(2)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/policies/rgp/second`)
    } finally {
      fetchStub.restore()
    }
  })
})
