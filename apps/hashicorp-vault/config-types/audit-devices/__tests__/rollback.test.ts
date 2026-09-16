import rollback from '../rollback'
import type { AuditDeviceRollbackEntry } from '../deploy'
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

const PRIOR = { type: 'file', description: 'old', options: { file_path: '/old.log' } }

function ctx(
  previousState: AuditDeviceRollbackEntry[] | undefined,
  o: { token?: string | null } = {},
) {
  return makeRollbackContext(
    makeCanvas([], 'audit-devices'),
    previousState === undefined ? {} : { previousState, createdPaths: [] },
    o,
  )
}

describe('Vault Audit Devices Rollback Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ path: 'file', existed: false }], { token: null }))

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

  it('disables a device the deploy enabled', async () => {
    const fetchStub = recordFetch([NO_CONTENT])
    try {
      const result = await rollback(ctx([{ path: 'file', existed: false }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/audit/file`)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      // Turning auditing off is a security-visible act; the message says so.
      expect(result.message).toMatch(/stops audit logging/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on disable as already gone', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await rollback(ctx([{ path: 'file', existed: false }]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/file/)
    } finally {
      fetchStub.restore()
    }
  })

  it('restores a device the deploy re-enabled by disabling then re-mounting the prior config', async () => {
    const fetchStub = recordFetch([NO_CONTENT, NO_CONTENT])
    try {
      const result = await rollback(ctx([{ path: 'file', existed: true, prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)
      expect(fetchStub.calls[0].method).toBe('DELETE')
      expect(fetchStub.calls[1].method).toBe('PUT')
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/audit/file`)
      expect(fetchStub.calls[1].headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        type: 'file',
        options: { file_path: '/old.log' },
        description: 'old',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('omits the description when the prior device had none', async () => {
    const fetchStub = recordFetch([NO_CONTENT, NO_CONTENT])
    try {
      await rollback(
        ctx([
          {
            path: 'file',
            existed: true,
            prior: { type: 'file', description: '', options: { file_path: '/old.log' } },
          },
        ]),
      )

      expect(JSON.parse(fetchStub.calls[1].body).description).toBeUndefined()
    } finally {
      fetchStub.restore()
    }
  })

  it('never disables a pre-existing device it has no prior config for', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await rollback(ctx([{ path: 'file', existed: true }]))

      expect(result.success).toBe(true)
      // Deleting here would blind a device this deploy never touched.
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the disable', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await rollback(ctx([{ path: 'file', existed: false }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to disable audit device "file"/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message)
    } finally {
      fetchStub.restore()
    }
  })

  it('says loudly when the device was disabled but its prior config could not be restored', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(ctx([{ path: 'file', existed: true, prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/could NOT be restored/)
      expect(result.message).toMatch(/permission denied/)
    } finally {
      fetchStub.restore()
    }
  })

  it('stops at the first failure and says how far it got', async () => {
    const fetchStub = recordFetch([NO_CONTENT, FORBIDDEN])
    try {
      const result = await rollback(
        ctx([
          { path: 'first', existed: false },
          { path: 'second', existed: false },
          { path: 'third', existed: false },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 3/)
      expect(fetchStub.calls).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })

  it('reverts every declared device when they all succeed', async () => {
    const fetchStub = recordFetch([NO_CONTENT, NO_CONTENT, NO_CONTENT])
    try {
      const result = await rollback(
        ctx([
          { path: 'first', existed: false },
          { path: 'second', existed: true, prior: PRIOR },
        ]),
      )

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Rolled back 2 audit device/)
      expect(fetchStub.calls).toHaveLength(3)
      expect(fetchStub.matching('/sys/audit/second')).toHaveLength(2)
    } finally {
      fetchStub.restore()
    }
  })
})
