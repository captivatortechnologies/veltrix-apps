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

const HCL = 'length = 20\nrule "charset" {\n  charset = "abcdefghijklmnopqrstuvwxyz"\n  min-chars = 1\n}'

function ctx(names: string[] = ['db-password'], o: { token?: string | null } = {}) {
  return makeDriftContext(
    makeCanvas(
      names.map((name, i) => ({ name: `Policy ${i + 1}`, fields: { name, policy: HCL } })),
      'password-policies',
    ),
    o,
  )
}

function live(policy: unknown) {
  return { status: 200, body: { data: { policy } } }
}

describe('Vault Password Policies Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(['db-password'], { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live policy matches', async () => {
    const fetchStub = recordFetch([live(HCL)])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].method).toBe('GET')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/password/db-password`)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores a cosmetic reflow — whitespace and newlines are not drift', async () => {
    const reflowed =
      'length = 20   rule "charset" {\n\n\n     charset = "abcdefghijklmnopqrstuvwxyz"   min-chars = 1\n}   '
    const fetchStub = recordFetch([live(reflowed)])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps a "#" in a charset meaningful — a comment is not normalized away', async () => {
    const withHash = HCL.replace('abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz#')
    const fetchStub = recordFetch([live(withHash)])
    try {
      const result = await driftDetect(ctx())

      // Unlike an ACL policy, "#" is a legal password character, so it is never
      // stripped as a comment — a changed charset is real drift.
      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('db-password.policy')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a shortened length as critical drift', async () => {
    const weakened = HCL.replace('length = 20', 'length = 6')
    const fetchStub = recordFetch([live(weakened)])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('db-password.policy')
      expect(result.diffs[0].severity).toBe('critical')
      expect(String(result.diffs[0].actual)).toMatch(/length = 6/)
      expect(String(result.diffs[0].expected)).toMatch(/length = 20/)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a policy with no body as fully drifted rather than throwing', async () => {
    const fetchStub = recordFetch([live(undefined)])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].actual).toBe('')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a managed policy deleted out of band as critical', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('db-password')
      expect(result.diffs[0].expected).toBe('exists')
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
      expect(String(result.diffs[0].actual)).toMatch(/permission denied/)
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining policies after one errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN, live(HCL)])
    try {
      const result = await driftDetect(ctx(['first', 'second']))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(fetchStub.calls).toHaveLength(2)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/policies/password/second`)
    } finally {
      fetchStub.restore()
    }
  })
})
