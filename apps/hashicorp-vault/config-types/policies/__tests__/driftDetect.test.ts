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

const HCL = 'path "secret/data/app/*" {\n  capabilities = ["read", "list"]\n}'

function ctx(o: { token?: string | null } = {}) {
  return makeDriftContext(
    makeCanvas([{ name: 'Policy 1', fields: { name: 'app-read', policy: HCL } }], 'policies'),
    o,
  )
}

describe('Vault ACL Policies Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx({ token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live policy matches', async () => {
    const fetchStub = recordFetch([{ status: 200, body: { data: { name: 'app-read', policy: HCL } } }])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/acl/app-read`)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores a cosmetic reformat — comments and whitespace are not drift', async () => {
    const reformatted =
      '# owned by platform team\npath   "secret/data/app/*"   {\n\n    capabilities = ["read", "list"]\n\n}\n'
    const fetchStub = recordFetch([
      { status: 200, body: { data: { name: 'app-read', policy: reformatted } } },
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a meaningful capability change as critical drift', async () => {
    const tampered = 'path "secret/data/app/*" {\n  capabilities = ["read", "list", "delete"]\n}'
    const fetchStub = recordFetch([
      { status: 200, body: { data: { name: 'app-read', policy: tampered } } },
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('app-read.policy')
      expect(result.diffs[0].severity).toBe('critical')
      expect(String(result.diffs[0].actual)).toMatch(/delete/)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a managed policy that has been deleted out of band', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('app-read')
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
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining policies after one errors', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Policy 1', fields: { name: 'first', policy: HCL } },
        { name: 'Policy 2', fields: { name: 'second', policy: HCL } },
      ],
      'policies',
    )
    const fetchStub = recordFetch([
      FORBIDDEN,
      { status: 200, body: { data: { name: 'second', policy: HCL } } },
    ])
    try {
      const result = await driftDetect(makeDriftContext(canvas))

      expect(result.hasDrift).toBe(true)
      // Only the first drifted; the second was still checked and matched.
      expect(result.diffs).toHaveLength(1)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
