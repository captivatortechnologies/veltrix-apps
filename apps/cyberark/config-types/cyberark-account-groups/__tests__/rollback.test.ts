import rollback from '../rollback'
import type { AccountGroupRollbackEntry } from '../deploy'
import {
  API_URL,
  LOGON,
  bodyOf,
  named,
  ok,
  pvwaError,
  recordFetch,
  rollbackContext,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const CREATED: AccountGroupRollbackEntry = {
  key: '["app-prod","sqlcluster"]',
  label: 'SQLCluster @ App-Prod',
  existed: false,
  groupId: '12',
  safeName: 'App-Prod',
  priorMemberAccountIds: [],
}

const UPDATED: AccountGroupRollbackEntry = {
  key: '["app-prod","webcluster"]',
  label: 'WebCluster @ App-Prod',
  existed: true,
  groupId: '13',
  safeName: 'App-Prod',
  priorMemberAccountIds: ['99_9'],
}

describe('CyberArk Account Groups Rollback Handler', () => {
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

  it('empties a group this deploy created and says the group object survives', async () => {
    const fake = recordFetch([LOGON, named('Members', [{ AccountID: '77_3' }]), ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/AccountGroups/12/Members/`)
      expect(calls[1].method).toBe('DELETE')
      expect(calls[1].url).toBe(`${API_URL}/AccountGroups/12/Members/77_3/`)

      // The Gen2 API has no delete-group endpoint, so the operator must be told.
      expect(result.success).toBe(true)
      expect(result.message).toMatch('could not be deleted')
      expect(result.message).toMatch('SQLCluster @ App-Prod')
    } finally {
      fake.restore()
    }
  })

  it('restores the exact prior membership of a group that already existed', async () => {
    const fake = recordFetch([LOGON, named('Members', [{ AccountID: '77_3' }]), ok(), ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      const calls = vendorCalls(fake.calls)
      // 99_9 was a member before the deploy and must come back...
      expect(calls[1].method).toBe('POST')
      expect(bodyOf(calls[1])).toEqual({ AccountID: '99_9' })
      // ...and 77_3, attached by the deploy, must go.
      expect(calls[2].method).toBe('DELETE')
      expect(calls[2].url).toBe(`${API_URL}/AccountGroups/13/Members/77_3/`)

      expect(result.success).toBe(true)
      expect(result.message.includes('could not be deleted')).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, named('Members', []), ok(), named('Members', [])])
    try {
      await rollback(rollbackContext({ previousState: [CREATED, UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/AccountGroups/13/Members/`)
      expect(calls[calls.length - 1].url).toBe(`${API_URL}/AccountGroups/12/Members/`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-detached member (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, named('Members', [{ AccountID: '77_3' }]), pvwaError(404, 'Member not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the detach', async () => {
    const fake = recordFetch([
      LOGON,
      named('Members', [{ AccountID: '77_3' }]),
      pvwaError(403, 'You are not authorized to update account groups'),
    ])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('You are not authorized to update account groups')
    } finally {
      fake.restore()
    }
  })

  it('skips a group whose GroupID was never captured rather than guessing one', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(
        rollbackContext({ previousState: [{ ...CREATED, groupId: undefined }] }),
      )

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
