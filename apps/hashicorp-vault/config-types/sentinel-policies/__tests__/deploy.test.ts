import deploy, { type SentinelPolicyRollbackEntry } from '../deploy'
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

const SENTINEL = 'main = rule {\n  identity.entity.metadata.role is "admin"\n}'
const PRIOR_SENTINEL = 'main = rule {\n  true\n}'

const RGP = { scope: 'rgp', name: 'require-admin', policy: SENTINEL, enforcementLevel: 'soft-mandatory' }
const EGP = {
  scope: 'egp',
  name: 'guard-secrets',
  policy: SENTINEL,
  enforcementLevel: 'hard-mandatory',
  paths: ['secret/*', 'kv/*'],
}

function canvasWith(policies: Array<Record<string, unknown>>) {
  return makeCanvas(
    policies.map((fields, i) => ({ name: `Policy ${i + 1}`, fields })),
    'sentinel-policies',
  )
}

function live(data: Record<string, unknown>) {
  return { status: 200, body: { data } }
}

function rollbackEntries(result: { rollbackData?: unknown }): SentinelPolicyRollbackEntry[] {
  return (result.rollbackData as { previousState?: SentinelPolicyRollbackEntry[] })?.previousState ?? []
}

function createdKeys(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdKeys?: string[] })?.createdKeys ?? []
}

describe('Vault Sentinel Policies Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([RGP]), { token: null }))

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
      const result = await deploy(makeDeployContext(canvasWith([RGP]), { hostname: '' }))

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
      const result = await deploy(makeDeployContext(canvasWith([RGP])))

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

  it('creates an RGP under /sys/policies/rgp and sends no paths', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([RGP])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/policies/rgp/require-admin`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/sys/policies/rgp/require-admin`)
      expect(write.headers['Content-Type']).toBe('application/json')
      // An RGP applies to the acting identity — Vault has no `paths` for it.
      expect(JSON.parse(write.body)).toEqual({
        policy: SENTINEL,
        enforcement_level: 'soft-mandatory',
      })

      expect(rollbackEntries(result)).toEqual([
        { scope: 'rgp', name: 'require-admin', existed: false },
      ])
      expect(createdKeys(result)).toEqual(['rgp/require-admin'])
    } finally {
      fetchStub.restore()
    }
  })

  it('creates an EGP under /sys/policies/egp and sends its paths', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([EGP])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/egp/guard-secrets`)
      expect(String(fetchStub.calls[1].url).includes('/sys/policies/rgp/')).toBe(false)
      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        policy: SENTINEL,
        enforcement_level: 'hard-mandatory',
        paths: ['secret/*', 'kv/*'],
      })
      expect(createdKeys(result)).toEqual(['egp/guard-secrets'])
    } finally {
      fetchStub.restore()
    }
  })

  it('routes by the declared scope even when it is authored in upper case', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ ...EGP, scope: 'EGP' }])))

      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/egp/guard-secrets`)
    } finally {
      fetchStub.restore()
    }
  })

  it('lowercases the policy name so the Vault identity stays stable', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ ...RGP, name: 'Require-Admin' }])))

      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/rgp/require-admin`)
    } finally {
      fetchStub.restore()
    }
  })

  it('captures the prior body and enforcement level of an RGP it updates', async () => {
    const fetchStub = recordFetch([
      live({
        name: 'require-admin',
        policy: PRIOR_SENTINEL,
        enforcement_level: 'advisory',
        paths: ['ignored/*'],
      }),
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([RGP])))

      expect(result.success).toBe(true)
      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].prior?.policy).toBe(PRIOR_SENTINEL)
      expect(entries[0].prior?.enforcementLevel).toBe('advisory')
      // An RGP has no paths, so nothing is carried even if Vault returned some.
      expect(entries[0].prior?.paths).toBeUndefined()
      expect(createdKeys(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('captures the prior paths of an EGP it updates', async () => {
    const fetchStub = recordFetch([
      live({ policy: PRIOR_SENTINEL, enforcement_level: 'advisory', paths: ['old/*'] }),
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([EGP])))

      expect(rollbackEntries(result)[0].prior?.paths).toEqual(['old/*'])
    } finally {
      fetchStub.restore()
    }
  })

  it('explains the Enterprise requirement when the write returns 404', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NOT_FOUND])
    try {
      const result = await deploy(makeDeployContext(canvasWith([RGP])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault Enterprise/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([RGP])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Failed to write Sentinel policy "rgp/require-admin"')
      expect(result.message).toMatch(/permission denied/)
      expect((result.artifacts as { deployedPolicies: string[] }).deployedPolicies).toEqual([])
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the prior-state read fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([RGP])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read Sentinel policy/)
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
            { ...RGP, name: 'first' },
            { ...RGP, name: 'second' },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2 polic/)
      // The first policy really was written — rollback must know about it.
      expect((result.artifacts as { deployedPolicies: string[] }).deployedPolicies).toEqual([
        'rgp/first',
      ])
      expect(rollbackEntries(result)).toHaveLength(2)
      expect(rollbackEntries(result)[0].name).toBe('first')
      expect(createdKeys(result)).toEqual(['rgp/first', 'rgp/second'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections missing a scope, name, body or enforcement level', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { ...RGP, scope: '' },
            { ...RGP, name: '' },
            { ...RGP, policy: '' },
            { ...RGP, enforcementLevel: '' },
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
