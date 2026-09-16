import deploy, { type PolicyRollbackEntry } from '../deploy'
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

const HCL = 'path "secret/data/app/*" {\n  capabilities = ["read", "list"]\n}'
const PRIOR_HCL = 'path "secret/data/app/*" {\n  capabilities = ["read"]\n}'

function canvasWith(policies: Array<Record<string, unknown>>) {
  return makeCanvas(
    policies.map((fields, i) => ({ name: `Policy ${i + 1}`, fields })),
    'policies',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): PolicyRollbackEntry[] {
  return ((result.rollbackData as { previousState?: PolicyRollbackEntry[] })?.previousState ?? [])
}

describe('Vault ACL Policies Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'app-read', policy: HCL }]), { token: null }),
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
        makeDeployContext(canvasWith([{ name: 'app-read', policy: HCL }]), { hostname: '' }),
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
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-read', policy: HCL }])))

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

  it('creates a policy that does not exist yet and records it for rollback', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-read', policy: HCL }])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/policies/acl/app-read`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/sys/policies/acl/app-read`)
      expect(JSON.parse(write.body).policy).toBe(HCL)

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      expect(entries[0].priorPolicy).toBeUndefined()
      expect((result.rollbackData as { createdNames: string[] }).createdNames).toEqual(['app-read'])
    } finally {
      fetchStub.restore()
    }
  })

  it('updates a policy that already exists and captures its prior body verbatim', async () => {
    const fetchStub = recordFetch([
      { status: 200, body: { data: { name: 'app-read', policy: PRIOR_HCL } } },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-read', policy: HCL }])))

      expect(result.success).toBe(true)

      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      // Verbatim — rollback restores the exact body Vault held, not a reformat.
      expect(entries[0].priorPolicy).toBe(PRIOR_HCL)
      expect((result.rollbackData as { createdNames: string[] }).createdNames).toEqual([])
      expect(JSON.parse(fetchStub.calls[1].body).policy).toBe(HCL)
    } finally {
      fetchStub.restore()
    }
  })

  it('lowercases the policy name so Vault identity stays stable', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ name: 'App-Read', policy: HCL }])))

      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/acl/app-read`)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-read', policy: HCL }])))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the prior-state read fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'app-read', policy: HCL }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/internal error/)
      // Nothing was written, so nothing should be claimed as deployed.
      expect((result.artifacts as { deployedPolicies: string[] }).deployedPolicies).toEqual([])
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
      // The first policy really was written — rollback must know about it.
      expect((result.artifacts as { deployedPolicies: string[] }).deployedPolicies).toEqual(['first'])
      expect((result.rollbackData as { createdNames: string[] }).createdNames).toEqual([
        'first',
        'second',
      ])
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses the reserved root policy before touching Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'ROOT', policy: HCL }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/reserved/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no name or no policy body', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: '', policy: HCL }, { name: 'app-read' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
