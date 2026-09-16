import healthCheck from '../healthCheck'
import {
  LOGON,
  collection,
  healthContext,
  item,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const MEMBERS = [
  item('Member 1', { safe_name: 'App-Prod', member_name: 'AppOwners', member_type: 'Group', permissions: ['useAccounts'] }),
  item('Member 2', { safe_name: 'App-Prod', member_name: 'AppReaders', member_type: 'Group', permissions: ['listAccounts'] }),
]

const SAFES = collection([{ safeUrlId: 'App-Prod', safeName: 'App-Prod' }])

describe('CyberArk Safe Members Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(MEMBERS, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared member still holds access', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([{ memberName: 'AppOwners' }, { memberName: 'AppReaders' }])])
    try {
      const result = await healthCheck(healthContext(MEMBERS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      // The safe's member list is read once and reused for both members.
      expect(vendorCalls(fake.calls)).toHaveLength(2)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific grant that has been revoked outside Veltrix', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([{ memberName: 'AppOwners' }])])
    try {
      const result = await healthCheck(healthContext(MEMBERS))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'member:AppReaders@App-Prod')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('fails the reachability check when the safe itself is gone', async () => {
    const fake = recordFetch([LOGON, collection([])])
    try {
      const result = await healthCheck(healthContext(MEMBERS))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch('Safe "App-Prod" not found')
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(MEMBERS))

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
