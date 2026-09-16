import rollback from '../rollback'
import type { AuthMethodRollbackEntry } from '../deploy'
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
  previousState: AuthMethodRollbackEntry[] | undefined,
  o: { token?: string | null; hostname?: string } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'auth-methods'),
    previousState === undefined ? {} : { previousState, createdPaths: [] },
    o,
  )
}

const ENABLED_BY_DEPLOY: AuthMethodRollbackEntry = {
  path: 'userpass',
  type: 'userpass',
  existed: false,
}

describe('Vault Auth Methods Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([ENABLED_BY_DEPLOY], { token: null }))

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
      const result = await rollback(ctx([ENABLED_BY_DEPLOY], { hostname: '' }))

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

  it('disables a method the deploy enabled and warns that it revokes leases and tokens', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([ENABLED_BY_DEPLOY]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/auth/userpass`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/DESTRUCTIVE/)
      expect(result.message).toMatch(/revokes every lease and token/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on disable as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([ENABLED_BY_DEPLOY]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/userpass/)
    } finally {
      fetchStub.restore()
    }
  })

  it('never disables a mount that pre-existed the deploy', async () => {
    const fetchStub = recordFetch([])
    try {
      // existed:true with nothing captured — deploy only adopted this mount, so
      // there is nothing to undo and certainly nothing to destroy.
      const result = await rollback(ctx([{ path: 'userpass', type: 'userpass', existed: true }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(result.message).toMatch(/Rolled back 1 auth method/)
      expect(String(result.message).includes('DESTRUCTIVE')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores the captured prior tuning for a method the deploy tuned', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          {
            path: 'userpass',
            type: 'userpass',
            existed: true,
            priorTune: {
              default_lease_ttl: 2764800,
              max_lease_ttl: 2764800,
              description: 'set by hand',
              token_type: 'default',
              listing_visibility: 'hidden',
            },
          },
        ]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/auth/userpass/tune`)
      // TTLs come back from Vault as seconds numbers and are echoed as-is.
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        default_lease_ttl: 2764800,
        max_lease_ttl: 2764800,
        description: 'set by hand',
        token_type: 'default',
        listing_visibility: 'hidden',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('omits from the restore body any field Vault never reported', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([{ path: 'userpass', type: 'userpass', existed: true, priorTune: { description: '' } }]),
      )

      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({ description: '' })
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the disable', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([ENABLED_BY_DEPLOY]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to disable auth method/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the tune restore', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { path: 'userpass', type: 'userpass', existed: true, priorTune: { description: 'old' } },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore tuning/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { path: 'first', type: 'userpass', existed: false },
          { path: 'second', type: 'approle', existed: false },
          { path: 'third', type: 'ldap', existed: false },
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
