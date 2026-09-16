import rollback from '../rollback'
import type { GroupRollbackEntry } from '../deploy'
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

function ctx(previousState: GroupRollbackEntry[] | undefined, o: { token?: string | null } = {}) {
  return makeRollbackContext(
    makeCanvas([], 'identity-groups'),
    previousState === undefined ? {} : { previousState, createdNames: [] },
    o,
  )
}

const INTERNAL_PRIOR: GroupRollbackEntry = {
  name: 'platform-admins',
  type: 'internal',
  existed: true,
  prior: {
    type: 'internal',
    policies: ['ops'],
    member_entity_ids: ['e-1'],
    member_group_ids: ['g-9'],
    metadata: { owner: 'platform' },
  },
}

describe('Vault Identity Groups Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(
        ctx([{ name: 'platform-admins', type: 'internal', existed: false }], { token: null }),
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

  it('deletes a group the deploy created and says what that removes', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ name: 'platform-admins', type: 'internal', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/group/name/platform-admins`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/removes their policy attachments/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([{ name: 'platform-admins', type: 'internal', existed: false }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/platform-admins/)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the prior state of an internal group, members included', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([INTERNAL_PRIOR]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/group/name/platform-admins`)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        type: 'internal',
        policies: ['ops'],
        member_entity_ids: ['e-1'],
        member_group_ids: ['g-9'],
        metadata: { owner: 'platform' },
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('never restores member lists onto an external group', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([
          {
            name: 'okta-admins',
            type: 'external',
            existed: true,
            prior: { type: 'external', policies: ['ops'], member_entity_ids: ['e-1'] },
          },
        ]),
      )

      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({ type: 'external', policies: ['ops'] })
    } finally {
      fetchStub.restore()
    }
  })

  it('omits metadata from the restore when none was captured', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([
          {
            name: 'platform-admins',
            type: 'internal',
            existed: true,
            prior: { type: 'internal', policies: [], metadata: null },
          },
        ]),
      )

      expect(fetchStub.calls[0].body.includes('metadata')).toBe(false)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        type: 'internal',
        policies: [],
        member_entity_ids: [],
        member_group_ids: [],
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('never deletes a pre-existing group with no captured prior state', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ name: 'platform-admins', type: 'internal', existed: true }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(result.message).toMatch(/Rolled back 1 identity group/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([{ name: 'platform-admins', type: 'internal', existed: false }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to delete identity group "platform-admins"/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the restore', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await rollback(ctx([INTERNAL_PRIOR]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore identity group "platform-admins"/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { name: 'first', type: 'internal', existed: false },
          { name: 'second', type: 'internal', existed: false },
          { name: 'third', type: 'internal', existed: false },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 3 group/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
