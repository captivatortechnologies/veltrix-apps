import rollback from '../rollback'
import type { LeaseCountQuotaRollbackEntry } from '../deploy'
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
  previousState: LeaseCountQuotaRollbackEntry[] | undefined,
  o: { token?: string | null } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'lease-count-quotas'),
    previousState === undefined ? {} : { previousState, createdNames: [] },
    o,
  )
}

describe('Vault Lease Count Quotas Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(
        ctx([{ name: 'db-leases', existed: false, path: 'database/' }], { token: null }),
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

  it('deletes a quota the deploy created', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ name: 'db-leases', existed: false, path: 'database/' }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/quotas/lease-count/db-leases`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on delete as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([{ name: 'db-leases', existed: false, path: 'database/' }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/db-leases/)
    } finally {
      fetchStub.restore()
    }
  })

  it('warns that deleting a created global limiter uncaps the whole cluster', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ name: 'cluster-wide', existed: false, path: '' }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/REMOVES global lease count limiting/)
      expect(result.message).toMatch(/cluster-wide/)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the exact prior cap for a quota the deploy overwrote', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          {
            name: 'db-leases',
            existed: true,
            path: 'database/',
            prior: { max_leases: 25, path: 'database/creds', role: 'readonly', inheritable: true },
          },
        ]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/quotas/lease-count/db-leases`)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        max_leases: 25,
        path: 'database/creds',
        role: 'readonly',
        inheritable: true,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('restores a captured inheritable:false rather than dropping it', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([
          {
            name: 'db-leases',
            existed: true,
            path: 'database/',
            prior: { max_leases: 25, inheritable: false },
          },
        ]),
      )

      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({ max_leases: 25, inheritable: false })
    } finally {
      fetchStub.restore()
    }
  })

  it('never deletes a pre-existing quota whose prior state was not captured', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ name: 'pre-existing', existed: true, path: 'database/' }]))

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
      const result = await rollback(ctx([{ name: 'db-leases', existed: false, path: 'database/' }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to delete lease count quota/)
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
        ctx([{ name: 'db-leases', existed: true, path: 'database/', prior: { max_leases: 25 } }]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore lease count quota/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { name: 'first', existed: false, path: 'database/' },
          { name: 'second', existed: false, path: 'database/' },
          { name: 'third', existed: false, path: 'database/' },
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
