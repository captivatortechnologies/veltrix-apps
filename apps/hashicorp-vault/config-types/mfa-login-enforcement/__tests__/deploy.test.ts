import deploy, { type EnforcementRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  NO_CONTENT,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const METHOD_A = '11111111-1111-4111-8111-111111111111'
const METHOD_B = '22222222-2222-4222-8222-222222222222'
const GROUP_A = '33333333-3333-4333-8333-333333333333'

const ENFORCEMENT = {
  name: 'admin-mfa',
  mfaMethodIds: METHOD_A,
  authMethodTypes: 'userpass',
}

function canvasWith(enforcements: Array<Record<string, unknown>>) {
  return makeCanvas(
    enforcements.map((fields, i) => ({ name: `Enforcement ${i + 1}`, fields })),
    'mfa-login-enforcement',
  )
}

function entries(result: { rollbackData?: unknown }): EnforcementRollbackEntry[] {
  return (result.rollbackData as { previousState?: EnforcementRollbackEntry[] })?.previousState ?? []
}

function createdNames(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdNames?: string[] })?.createdNames ?? []
}

function artifacts(result: { artifacts?: unknown }) {
  return result.artifacts as { deployedEnforcements: string[]; createdEnforcements: string[] }
}

describe('Vault Login-MFA Enforcement Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ENFORCEMENT]), { token: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault token/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ENFORCEMENT]), { hostname: '' }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ENFORCEMENT])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      for (const call of fetchStub.calls) {
        expect(call.headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      }
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('creates an enforcement that does not exist yet and sends every selector array', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ENFORCEMENT])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/identity/mfa/login-enforcement/admin-mfa`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/identity/mfa/login-enforcement/admin-mfa`)
      // Unset selectors go as empty arrays so the write fully converges the object.
      expect(JSON.parse(write.body)).toEqual({
        mfa_method_ids: [METHOD_A],
        auth_method_types: ['userpass'],
        auth_method_accessors: [],
        identity_group_ids: [],
        identity_entity_ids: [],
      })

      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].existed).toBe(false)
      expect(entries(result)[0].priorState).toBeUndefined()
      expect(createdNames(result)).toEqual(['admin-mfa'])
    } finally {
      fetchStub.restore()
    }
  })

  it('splits and de-dupes a comma-separated method id list', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            {
              name: 'admin-mfa',
              mfaMethodIds: `${METHOD_A}, ${METHOD_B}, ${METHOD_A}`,
              authMethodTypes: 'userpass,ldap',
            },
          ]),
        ),
      )

      const body = JSON.parse(fetchStub.calls[1].body)
      expect(body.mfa_method_ids).toEqual([METHOD_A, METHOD_B])
      expect(body.auth_method_types).toEqual(['userpass', 'ldap'])
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts selector fields supplied as arrays', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            {
              name: 'admin-mfa',
              mfaMethodIds: [METHOD_A],
              identityGroupIds: [GROUP_A],
              authMethodAccessors: ['auth_userpass_1a2b3c4d'],
            },
          ]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        mfa_method_ids: [METHOD_A],
        auth_method_types: [],
        auth_method_accessors: ['auth_userpass_1a2b3c4d'],
        identity_group_ids: [GROUP_A],
        identity_entity_ids: [],
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('updates an enforcement that already exists and captures its prior authored state', async () => {
    const fetchStub = recordFetch([
      {
        status: 200,
        body: {
          data: {
            id: 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa',
            name: 'admin-mfa',
            namespace_id: 'root',
            mfa_method_ids: [METHOD_B],
            auth_method_types: ['ldap'],
            identity_group_ids: [GROUP_A],
          },
        },
      },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ENFORCEMENT])))

      expect(result.success).toBe(true)
      const entry = entries(result)[0]
      expect(entry.existed).toBe(true)
      // Server-computed fields are dropped; every authored list is present.
      expect(entry.priorState).toEqual({
        mfa_method_ids: [METHOD_B],
        auth_method_types: ['ldap'],
        auth_method_accessors: [],
        identity_group_ids: [GROUP_A],
        identity_entity_ids: [],
      })
      expect(createdNames(result)).toEqual([])
      expect(JSON.parse(fetchStub.calls[1].body).mfa_method_ids).toEqual([METHOD_A])
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ENFORCEMENT])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to write login-MFA enforcement/)
      expect(result.message).toMatch(/permission denied/)
      expect(artifacts(result).deployedEnforcements).toEqual([])
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the prior-state read fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ENFORCEMENT])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read login-MFA enforcement/)
      expect(artifacts(result).deployedEnforcements).toEqual([])
      expect(entries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later enforcement fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { name: 'first', mfaMethodIds: METHOD_A, authMethodTypes: 'userpass' },
            { name: 'second', mfaMethodIds: METHOD_B, authMethodTypes: 'ldap' },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 2/)
      // The first enforcement really was written — rollback must know about it.
      expect(artifacts(result).deployedEnforcements).toEqual(['first'])
      expect(entries(result)).toHaveLength(2)
      expect(createdNames(result)).toEqual(['first', 'second'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no name or no MFA method id before touching Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { name: '', mfaMethodIds: METHOD_A },
            { name: 'no-methods', authMethodTypes: 'userpass' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
