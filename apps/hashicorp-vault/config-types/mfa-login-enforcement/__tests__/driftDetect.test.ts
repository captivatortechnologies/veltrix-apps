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

const METHOD_A = '11111111-1111-4111-8111-111111111111'
const METHOD_B = '22222222-2222-4222-8222-222222222222'
const GROUP_A = '33333333-3333-4333-8333-333333333333'

const AUTHORED = {
  name: 'admin-mfa',
  mfaMethodIds: `${METHOD_A},${METHOD_B}`,
  authMethodTypes: 'userpass,ldap',
}

function ctx(fields: Record<string, unknown> = AUTHORED, o: { token?: string | null } = {}) {
  return makeDriftContext(makeCanvas([{ name: 'Enforcement 1', fields }], 'mfa-login-enforcement'), o)
}

function live(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

describe('Vault Login-MFA Enforcement Drift Detect Handler', () => {
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

  it('reports no drift when the live enforcement matches', async () => {
    const fetchStub = recordFetch([
      live({ mfa_method_ids: [METHOD_A, METHOD_B], auth_method_types: ['userpass', 'ldap'] }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/mfa/login-enforcement/admin-mfa`)
      expect(fetchStub.calls[0].method).toBe('GET')
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores a reordered id list — order is not significant on a selector', async () => {
    const fetchStub = recordFetch([
      live({ mfa_method_ids: [METHOD_B, METHOD_A], auth_method_types: ['ldap', 'userpass'] }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores the server-computed id and namespace fields', async () => {
    const fetchStub = recordFetch([
      live({
        id: 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
        name: 'renamed-by-server',
        namespace_id: 'root',
        mfa_method_ids: [METHOD_A, METHOD_B],
        auth_method_types: ['userpass', 'ldap'],
      }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a changed MFA method list as critical — it changes what MFA is required', async () => {
    const fetchStub = recordFetch([
      live({ mfa_method_ids: [METHOD_A], auth_method_types: ['userpass', 'ldap'] }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('admin-mfa.mfa_method_ids')
      expect(result.diffs[0].severity).toBe('critical')
      expect(String(result.diffs[0].expected)).toMatch(METHOD_B)
      expect(String(result.diffs[0].actual).includes(METHOD_B)).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an enforcement stripped of every method as critical', async () => {
    const fetchStub = recordFetch([live({ auth_method_types: ['userpass', 'ldap'] })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('admin-mfa.mfa_method_ids')
      expect(result.diffs[0].actual).toBe('none')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a widened auth method selector as a warning', async () => {
    const fetchStub = recordFetch([
      live({ mfa_method_ids: [METHOD_A, METHOD_B], auth_method_types: ['userpass', 'ldap', 'okta'] }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('admin-mfa.auth_method_types')
      expect(result.diffs[0].severity).toBe('warning')
      expect(String(result.diffs[0].actual)).toMatch(/okta/)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an identity group selector that has been cleared', async () => {
    const fetchStub = recordFetch([live({ mfa_method_ids: [METHOD_A], auth_method_types: ['userpass'] })])
    try {
      const result = await driftDetect(
        ctx({
          name: 'admin-mfa',
          mfaMethodIds: METHOD_A,
          authMethodTypes: 'userpass',
          identityGroupIds: GROUP_A,
        }),
      )

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('admin-mfa.identity_group_ids')
      expect(result.diffs[0].expected).toBe(GROUP_A)
      expect(result.diffs[0].actual).toBe('none')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a managed enforcement that has been deleted out of band', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('admin-mfa')
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

  it('keeps checking the remaining enforcements after one errors', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Enforcement 1', fields: { name: 'first', mfaMethodIds: METHOD_A } },
        { name: 'Enforcement 2', fields: { name: 'second', mfaMethodIds: METHOD_B } },
      ],
      'mfa-login-enforcement',
    )
    const fetchStub = recordFetch([FORBIDDEN, live({ mfa_method_ids: [METHOD_B] })])
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
