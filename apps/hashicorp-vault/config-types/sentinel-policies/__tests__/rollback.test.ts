import rollback from '../rollback'
import type { SentinelPolicyRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  NO_CONTENT,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeRollbackContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const PRIOR_SENTINEL = 'main = rule {\n  true\n}'

function ctx(
  previousState: SentinelPolicyRollbackEntry[] | undefined,
  o: { token?: string | null } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'sentinel-policies'),
    previousState === undefined ? {} : { previousState, createdKeys: [] },
    o,
  )
}

describe('Vault Sentinel Policies Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(
        ctx([{ scope: 'rgp', name: 'require-admin', existed: false }], { token: null }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault token/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure when there is no previous state to restore', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure for an empty previous state rather than claiming success', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('deletes a created RGP from the rgp endpoint', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ scope: 'rgp', name: 'require-admin', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/rgp/require-admin`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('deletes a created EGP from the egp endpoint', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ scope: 'egp', name: 'guard-secrets', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/egp/guard-secrets`)
      expect(String(fetchStub.calls[0].url).includes('/sys/policies/rgp/')).toBe(false)
      expect(result.message).toMatch(/egp\/guard-secrets/)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([{ scope: 'rgp', name: 'require-admin', existed: false }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/rgp\/require-admin/)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores an updated RGP to its prior body without inventing paths', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          {
            scope: 'rgp',
            name: 'require-admin',
            existed: true,
            prior: { policy: PRIOR_SENTINEL, enforcementLevel: 'advisory' },
          },
        ]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/rgp/require-admin`)
      expect(fetchStub.calls[0].headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        policy: PRIOR_SENTINEL,
        enforcement_level: 'advisory',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('restores an updated EGP with its prior paths', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([
          {
            scope: 'egp',
            name: 'guard-secrets',
            existed: true,
            prior: {
              policy: PRIOR_SENTINEL,
              enforcementLevel: 'hard-mandatory',
              paths: ['old/*'],
            },
          },
        ]),
      )

      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        policy: PRIOR_SENTINEL,
        enforcement_level: 'hard-mandatory',
        paths: ['old/*'],
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('does nothing for a policy that existed but has no prior snapshot', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ scope: 'rgp', name: 'require-admin', existed: true }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([{ scope: 'rgp', name: 'require-admin', existed: false }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Failed to delete Sentinel policy "rgp/require-admin"')
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the restore', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          {
            scope: 'rgp',
            name: 'require-admin',
            existed: true,
            prior: { policy: PRIOR_SENTINEL, enforcementLevel: 'advisory' },
          },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Failed to restore Sentinel policy "rgp/require-admin"')
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { scope: 'rgp', name: 'first', existed: false },
          { scope: 'rgp', name: 'second', existed: false },
          { scope: 'rgp', name: 'third', existed: false },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 3/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps rgp and egp policies of the same name apart', async () => {
    const fetchStub = recordFetch([NO_CONTENT, NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          { scope: 'rgp', name: 'shared', existed: false },
          { scope: 'egp', name: 'shared', existed: false },
        ]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/policies/rgp/shared`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/policies/egp/shared`)
    } finally {
      fetchStub.restore()
    }
  })
})
