import deploy, { type PasswordPolicyRollbackEntry } from '../deploy'
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

const HCL = 'length = 20\nrule "charset" {\n  charset = "abcdefghijklmnopqrstuvwxyz"\n  min-chars = 1\n}'
const PRIOR_HCL = 'length = 12\nrule "charset" {\n  charset = "abc"\n  min-chars = 1\n}'

function canvasWith(policies: Array<Record<string, unknown>>) {
  return makeCanvas(
    policies.map((fields, i) => ({ name: `Policy ${i + 1}`, fields })),
    'password-policies',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): PasswordPolicyRollbackEntry[] {
  return (result.rollbackData as { previousState?: PasswordPolicyRollbackEntry[] })?.previousState ?? []
}

function createdNames(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdNames?: string[] })?.createdNames ?? []
}

describe('Vault Password Policies Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'db-password', policy: HCL }]), { token: null }),
      )

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
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'db-password', policy: HCL }]), { hostname: '' }),
      )

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
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'db-password', policy: HCL }])),
      )

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

  it('creates a policy that does not exist yet under the password endpoint', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'db-password', policy: HCL }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/policies/password/db-password`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/sys/policies/password/db-password`)
      expect(write.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(write.body)).toEqual({ policy: HCL })
      // A generation policy is not an ACL policy — never the acl endpoint.
      expect(String(write.url).includes('/sys/policies/acl')).toBe(false)

      expect(rollbackEntries(result)).toEqual([{ name: 'db-password', existed: false }])
      expect(createdNames(result)).toEqual(['db-password'])
    } finally {
      fetchStub.restore()
    }
  })

  it('updates a policy that already exists and captures its prior body verbatim', async () => {
    const fetchStub = recordFetch([{ status: 200, body: { data: { policy: PRIOR_HCL } } }, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'db-password', policy: HCL }])),
      )

      expect(result.success).toBe(true)
      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].priorPolicy).toBe(PRIOR_HCL)
      expect(createdNames(result)).toEqual([])
      expect(JSON.parse(fetchStub.calls[1].body).policy).toBe(HCL)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps the policy name verbatim — unlike an ACL policy, case is the identity', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'DB-Password', policy: HCL }])),
      )

      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/password/DB-Password`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/policies/password/DB-Password`)
      expect(createdNames(result)).toEqual(['DB-Password'])
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'db-password', policy: HCL }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Failed to write password policy "db-password"')
      expect(result.message).toMatch(/permission denied/)
      expect(
        (result.artifacts as { deployedPasswordPolicies: string[] }).deployedPasswordPolicies,
      ).toEqual([])
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the prior-state read fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'db-password', policy: HCL }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read password policy "db-password"/)
      expect(result.message).toMatch(/internal error/)
      expect(rollbackEntries(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later policy fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { name: 'first', policy: HCL },
            { name: 'second', policy: HCL },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2 policy/)
      // The first policy really was written — rollback must know about it.
      expect(
        (result.artifacts as { deployedPasswordPolicies: string[] }).deployedPasswordPolicies,
      ).toEqual(['first'])
      expect(rollbackEntries(result)).toHaveLength(2)
      expect(rollbackEntries(result)[0].name).toBe('first')
      expect(createdNames(result)).toEqual(['first', 'second'])
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a prior policy with no body as an empty prior rather than a create', async () => {
    const fetchStub = recordFetch([{ status: 200, body: { data: {} } }, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'db-password', policy: HCL }])),
      )

      expect(rollbackEntries(result)[0].existed).toBe(true)
      expect(rollbackEntries(result)[0].priorPolicy).toBe('')
      expect(createdNames(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no name or no policy body', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: '', policy: HCL }, { name: 'db-password' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
