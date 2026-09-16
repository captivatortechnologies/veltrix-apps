import rollback from '../rollback'
import type { VaultUserRollbackEntry } from '../deploy'
import {
  API_URL,
  LOGON,
  bodyOf,
  ok,
  pvwaError,
  recordFetch,
  rollbackContext,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const CREATED: VaultUserRollbackEntry = { key: 'svc-backup', label: 'svc-backup', existed: false, id: '42' }

const UPDATED: VaultUserRollbackEntry = {
  key: 'svc-legacy',
  label: 'svc-legacy',
  existed: true,
  id: '7',
  prior: {
    id: 7,
    username: 'svc-legacy',
    description: 'the description it had before',
    enableUser: false,
    vaultAuthorization: ['AuditUsers'],
  },
}

describe('CyberArk Vault Users Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }, { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('refuses when the deployment recorded no previous state', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('deletes a Vault user this deploy created', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${API_URL}/Users/42`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('restores the captured non-secret fields of a user this deploy updated', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      const restore = vendorCalls(fake.calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.url).toBe(`${API_URL}/Users/7`)

      const body = bodyOf(restore) as Record<string, unknown>
      expect(body.description).toBe('the description it had before')
      expect(body.enableUser).toBe(false)
      // The password is never captured, so a restore can never carry one.
      expect(body.initialPassword).toBeUndefined()
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok()])
    try {
      await rollback(rollbackContext({ previousState: [CREATED, UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/Users/7`)
      expect(calls[1].url).toBe(`${API_URL}/Users/42`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-deleted user (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'User not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the restore', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Not authorized to update users')])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to update users')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })

  it('skips a created user whose id was never returned by PVWA', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(
        rollbackContext({ previousState: [{ key: 'x', label: 'svc-backup', existed: false }] }),
      )

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
