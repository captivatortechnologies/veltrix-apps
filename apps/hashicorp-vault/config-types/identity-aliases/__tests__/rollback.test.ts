import rollback from '../rollback'
import type { IdentityAliasRollbackEntry } from '../deploy'
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

const ACCESSOR = 'auth_userpass_1a2b3c4d'
const PRIOR_ENTITY_ID = '8d4b0f0e-1a2b-4c3d-9e8f-000000000002'

function ctx(
  previousState: IdentityAliasRollbackEntry[] | undefined,
  o: { token?: string | null } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'identity-aliases'),
    previousState === undefined ? {} : { previousState, createdIds: [] },
    o,
  )
}

const created = (aliasId?: string): IdentityAliasRollbackEntry => ({
  kind: 'entity',
  name: 'alice',
  mountAccessor: ACCESSOR,
  existed: false,
  aliasId,
})

const updated = (priorCanonicalId?: string): IdentityAliasRollbackEntry => ({
  kind: 'entity',
  name: 'alice',
  mountAccessor: ACCESSOR,
  existed: true,
  aliasId: 'al-1',
  priorCanonicalId,
})

describe('Vault Identity Aliases Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([created('al-1')], { token: null }))

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

  it('deletes an alias the deploy created, addressed by its captured id', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([created('al-1')]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/entity-alias/id/al-1`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/no longer resolve to the entity\/group/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([created('al-1')]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/entity\/auth_userpass_1a2b3c4d\/alice/)
    } finally {
      fetchStub.restore()
    }
  })

  it('cannot delete a created alias whose id was never captured, and makes no call', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([created(undefined)]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      // Nothing was deleted, so the login-mapping warning must not appear.
      expect(result.message.includes('WARNING')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the prior canonical_id for an alias the deploy re-pointed', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([updated(PRIOR_ENTITY_ID)]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/entity-alias/id/al-1`)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        name: 'alice',
        canonical_id: PRIOR_ENTITY_ID,
        mount_accessor: ACCESSOR,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('leaves an updated alias alone when no prior canonical_id was captured', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([updated(undefined)]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('uses the group-alias namespace for a group alias', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([{ kind: 'group', name: 'engineering', mountAccessor: ACCESSOR, existed: false, aliasId: 'gal-1' }]),
      )

      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/group-alias/id/gal-1`)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([created('al-1')]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to delete entity alias "entity\/auth_userpass_1a2b3c4d\/alice"/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the restore', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await rollback(ctx([updated(PRIOR_ENTITY_ID)]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore entity alias/)
      expect(result.message).toMatch(/internal error/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { ...created('al-1'), name: 'first' },
          { ...created('al-2'), name: 'second' },
          { ...created('al-3'), name: 'third' },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 3 alias/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
