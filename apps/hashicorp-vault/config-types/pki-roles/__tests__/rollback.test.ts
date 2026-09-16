import rollback from '../rollback'
import type { PkiRoleRollbackEntry } from '../deploy'
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

function ctx(
  previousState: PkiRoleRollbackEntry[] | undefined,
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'pki-roles'),
    previousState === undefined ? {} : { previousState, createdKeys: [] },
    o,
  )
}

const CREATED_BY_DEPLOY: PkiRoleRollbackEntry = { mount: 'pki', name: 'web', existed: false }

describe('Vault PKI Roles Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY], { token: null }))

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
      const result = await rollback(ctx([CREATED_BY_DEPLOY], { hostname: '' }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
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

  it('deletes a role the deploy created and notes that issued certificates survive', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/pki/roles/web`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/certificates already issued under them are unaffected/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('never deletes a role that pre-existed the deploy', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ mount: 'pki', name: 'web', existed: true }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(String(result.message).includes('Deleted')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the complete prior role body for a role the deploy overwrote', async () => {
    const prior = {
      ttl: '24h',
      allowed_domains: ['old.example.com'],
      allow_any_name: true,
      policy_identifiers: ['1.3.6.1.4.1.99'],
    }
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([{ mount: 'pki', name: 'web', existed: true, priorBody: prior }]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/pki/roles/web`)
      // A role write fully replaces the role, so only the whole prior object
      // reproduces it — including fields this config type never models.
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual(prior)
      expect(fetchStub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/pki\/web/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the delete', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([CREATED_BY_DEPLOY]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to delete PKI role/)
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
        ctx([{ mount: 'pki', name: 'web', existed: true, priorBody: { ttl: '24h' } }]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore PKI role/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { mount: 'pki', name: 'one', existed: false },
          { mount: 'pki', name: 'two', existed: false },
          { mount: 'pki', name: 'three', existed: false },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 3/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
