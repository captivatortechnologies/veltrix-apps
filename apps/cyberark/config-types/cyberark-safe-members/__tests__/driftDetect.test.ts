import driftDetect from '../driftDetect'
import {
  LOGON,
  collection,
  driftContext,
  item,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const MEMBER = item('Member 1', {
  safe_name: 'App-Prod',
  member_name: 'AppOwners',
  member_type: 'Group',
  permissions: ['useAccounts', 'retrieveAccounts'],
})

const SAFES = collection([{ safeUrlId: 'App-Prod', safeName: 'App-Prod' }])

const IN_SYNC = {
  memberName: 'AppOwners',
  memberType: 'Group',
  membershipExpirationDate: null,
  permissions: { useAccounts: true, retrieveAccounts: true },
}

describe('CyberArk Safe Members Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([MEMBER], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the live grant matches the deployed config', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([IN_SYNC])])
    try {
      const result = await driftDetect(driftContext([MEMBER]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports a revoked member as critical drift', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([])])
    try {
      const result = await driftDetect(driftContext([MEMBER]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('AppOwners@App-Prod')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fake.restore()
    }
  })

  it('reports a privilege escalation made outside Veltrix', async () => {
    const escalated = { ...IN_SYNC, permissions: { ...IN_SYNC.permissions, manageSafe: true, deleteAccounts: true } }
    const fake = recordFetch([LOGON, SAFES, collection([escalated])])
    try {
      const result = await driftDetect(driftContext([MEMBER]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'AppOwners@App-Prod.permissions')
      expect(diff?.severity).toBe('warning')
      expect(String(diff?.expected)).toBe('retrieveAccounts, useAccounts')
      expect(String(diff?.actual)).toMatch('manageSafe')
      expect(String(diff?.actual)).toMatch('deleteAccounts')
    } finally {
      fake.restore()
    }
  })

  it('reports an expiration change as informational drift', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([{ ...IN_SYNC, membershipExpirationDate: 1_760_000_000 }])])
    try {
      const result = await driftDetect(driftContext([MEMBER]))

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('AppOwners@App-Prod.expiration')
      expect(result.diffs[0].expected).toBe('never')
      expect(result.diffs[0].actual).toBe(1_760_000_000)
      expect(result.diffs[0].severity).toBe('info')
    } finally {
      fake.restore()
    }
  })

  it('leaves member diffs unattributed without spending an extra call on it', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([])])
    try {
      const result = await driftDetect(driftContext([MEMBER]))

      // A Gen2 safe member carries no creator/modifier metadata and has no
      // activity endpoint — attribution must resolve nothing and cost nothing.
      expect(result.diffs[0].actor).toBeUndefined()
      expect(vendorCalls(fake.calls)).toHaveLength(2)
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([MEMBER]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
