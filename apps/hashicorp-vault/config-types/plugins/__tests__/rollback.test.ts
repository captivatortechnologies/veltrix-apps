import rollback from '../rollback'
import type { PluginRollbackEntry } from '../deploy'
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

const SHA_B = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'

function ctx(previousState: PluginRollbackEntry[] | undefined, o: { token?: string | null } = {}) {
  return makeRollbackContext(
    makeCanvas([], 'plugins'),
    previousState === undefined ? {} : { previousState, createdPlugins: [] },
    o,
  )
}

describe('Vault Plugin Catalog Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(
        ctx([{ type: 'secret', name: 'acme-kv', existed: false }], { token: null }),
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

  it('deregisters a plugin the deploy registered and warns about broken mounts', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ type: 'secret', name: 'acme-kv', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/plugins/catalog/secret/acme-kv`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      expect(result.message).toMatch(/BREAKS any secret\/auth\/database mount/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on deregister as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([{ type: 'secret', name: 'acme-kv', existed: false }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/secret\/acme-kv/)
    } finally {
      fetchStub.restore()
    }
  })

  it('re-registers the captured prior metadata for a plugin the deploy updated', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          {
            type: 'secret',
            name: 'acme-kv',
            existed: true,
            prior: { sha256: SHA_B, command: 'acme-kv-old', args: ['--legacy'], version: 'v1.0.0' },
          },
        ]),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('POST')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/plugins/catalog/secret/acme-kv`)
      expect(JSON.parse(fetchStub.calls[0].body)).toEqual({
        sha256: SHA_B,
        command: 'acme-kv-old',
        args: ['--legacy'],
        version: 'v1.0.0',
      })
      // env is never readable, so the restore must say it could not be reinstated.
      expect(result.message).toMatch(/env could NOT be reinstated/)
    } finally {
      fetchStub.restore()
    }
  })

  it('omits prior fields Vault never returned instead of inventing them', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      await rollback(
        ctx([{ type: 'secret', name: 'acme-kv', existed: true, prior: { sha256: SHA_B, command: 'acme-kv' } }]),
      )

      const body = JSON.parse(fetchStub.calls[0].body)
      expect(body).toEqual({ sha256: SHA_B, command: 'acme-kv' })
      expect(Object.keys(body).includes('env')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('never deregisters a pre-existing plugin whose prior state was not captured', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ type: 'secret', name: 'pre-existing', existed: true }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/secret\/pre-existing/)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the deregister', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([{ type: 'secret', name: 'acme-kv', existed: false }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to deregister plugin/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the re-registration', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(
        ctx([{ type: 'secret', name: 'acme-kv', existed: true, prior: { sha256: SHA_B } }]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to restore plugin/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { type: 'secret', name: 'first', existed: false },
          { type: 'secret', name: 'second', existed: false },
          { type: 'auth', name: 'third', existed: false },
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
