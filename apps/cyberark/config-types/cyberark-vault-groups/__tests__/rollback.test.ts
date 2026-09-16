import rollback from '../rollback'
import type { VaultGroupRollbackEntry } from '../deploy'
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

const CREATED: VaultGroupRollbackEntry = {
  key: 'vault admins',
  label: 'Vault Admins',
  existed: false,
  id: '7',
  priorMembers: [],
}

const UPDATED: VaultGroupRollbackEntry = {
  key: 'vault operators',
  label: 'Vault Operators',
  existed: true,
  id: '9',
  prior: { groupName: 'Vault Operators', description: 'the description it had before', location: '\\' },
  priorMembers: [{ username: 'bob', memberType: 'vault' }],
}

describe('CyberArk Vault Groups Rollback Handler', () => {
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

  it('deletes a group this deploy created', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${API_URL}/UserGroups/7`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('restores the fields and the exact prior membership of an updated group', async () => {
    const fake = recordFetch([
      LOGON,
      ok(),
      ok({ id: 9, members: [{ username: 'alice', memberType: 'vault' }] }),
      ok(),
      ok(),
    ])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].method).toBe('PUT')
      expect(bodyOf(calls[0])).toEqual({
        groupName: 'Vault Operators',
        description: 'the description it had before',
        location: '\\',
      })

      expect(calls[1].url).toBe(`${API_URL}/UserGroups/9?includeMembers=true`)

      // bob was a member before the deploy and must come back...
      expect(calls[2].method).toBe('POST')
      expect(bodyOf(calls[2])).toEqual({ memberId: 'bob', memberType: 'vault' })
      // ...and alice, added by the deploy, must go.
      expect(calls[3].method).toBe('DELETE')
      expect(calls[3].url).toBe(`${API_URL}/UserGroups/9/members/alice`)

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok({ id: 9, members: [] }), ok()])
    try {
      await rollback(rollbackContext({ previousState: [CREATED, UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/UserGroups/9`)
      expect(calls[calls.length - 1].url).toBe(`${API_URL}/UserGroups/7`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-deleted group (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Group not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the delete', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Not authorized to delete groups')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to delete groups')
    } finally {
      fake.restore()
    }
  })

  it('skips a group whose id was never captured rather than guessing one', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(
        rollbackContext({ previousState: [{ key: 'x', label: 'Vault Admins', existed: false, priorMembers: [] }] }),
      )

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
