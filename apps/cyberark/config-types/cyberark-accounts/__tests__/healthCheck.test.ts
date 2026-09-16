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

const ACCOUNTS = [
  item('Account 1', { name: 'svc-sql', safe_name: 'App-Prod', platform_id: 'WinServerLocal' }),
  item('Account 2', { name: 'svc-web', safe_name: 'App-Prod', platform_id: 'WinServerLocal' }),
]

const found = (name: string) => collection([{ id: '1', name, safeName: 'App-Prod' }])

describe('CyberArk Accounts Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(ACCOUNTS, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared account is present', async () => {
    const fake = recordFetch([LOGON, found('svc-sql'), found('svc-web')])
    try {
      const result = await healthCheck(healthContext(ACCOUNTS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      // One search per account — presence is checked by (name, safe), never by
      // reading the secret.
      expect(vendorCalls(fake.calls)).toHaveLength(2)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific account that has gone missing', async () => {
    const fake = recordFetch([LOGON, found('svc-sql'), collection([])])
    try {
      const result = await healthCheck(healthContext(ACCOUNTS))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'account:svc-web@App-Prod')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('still proves reachability when nothing is declared', async () => {
    const fake = recordFetch([LOGON, collection([])])
    try {
      const result = await healthCheck(healthContext([]))

      expect(result.healthy).toBe(true)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(ACCOUNTS))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
