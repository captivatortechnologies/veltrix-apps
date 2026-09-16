import rollback from '../rollback'
import type { EnforcementRollbackEntry } from '../deploy'
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

const METHOD_A = '11111111-1111-4111-8111-111111111111'
const GROUP_A = '33333333-3333-4333-8333-333333333333'

const PRIOR_STATE = {
  mfa_method_ids: [METHOD_A],
  auth_method_types: ['ldap'],
  auth_method_accessors: [],
  identity_group_ids: [GROUP_A],
  identity_entity_ids: [],
}

function ctx(previousState: EnforcementRollbackEntry[] | undefined, o: { token?: string | null } = {}) {
  return makeRollbackContext(
    makeCanvas([], 'mfa-login-enforcement'),
    previousState === undefined ? {} : { previousState, createdNames: [] },
    o,
  )
}

describe('Vault Login-MFA Enforcement Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ name: 'admin-mfa', existed: false }], { token: null }))

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

  it('deletes an enforcement the deploy created and warns that MFA is now gone', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ name: 'admin-mfa', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/mfa/login-enforcement/admin-mfa`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/authenticate WITHOUT it/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([{ name: 'admin-mfa', existed: false }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/admin-mfa/)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the prior authored body for an enforcement the deploy updated', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([{ name: 'admin-mfa', existed: true, priorState: PRIOR_STATE }]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/mfa/login-enforcement/admin-mfa`)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual(PRIOR_STATE)
      // Nothing was deleted, so the no-MFA warning must not appear.
      expect(String(result.message).includes('authenticate WITHOUT it')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('never touches a pre-existing enforcement whose prior state was not captured', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ name: 'pre-existing', existed: true }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/pre-existing/)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([{ name: 'admin-mfa', existed: false }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to delete login-MFA enforcement/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the restore', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([{ name: 'admin-mfa', existed: true, priorState: PRIOR_STATE }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore login-MFA enforcement/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { name: 'first', existed: false },
          { name: 'second', existed: false },
          { name: 'third', existed: false },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 3/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
