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

const SAFES = [
  item('Safe 1', { safe_name: 'App-Prod', retention_type: 'days', retention_count: 7 }),
  item('Safe 2', { safe_name: 'App-Legacy', retention_type: 'versions', retention_count: 5 }),
]

describe('CyberArk Safes Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(SAFES, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared safe is present', async () => {
    const fake = recordFetch([LOGON, collection([{ safeName: 'App-Prod' }, { safeName: 'App-Legacy' }])])
    try {
      const result = await healthCheck(healthContext(SAFES))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific safe that has gone missing', async () => {
    const fake = recordFetch([LOGON, collection([{ safeName: 'App-Prod' }])])
    try {
      const result = await healthCheck(healthContext(SAFES))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'safe:App-Legacy')
      expect(missing).toBeDefined()
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
      // 2 of 3 checks passed.
      expect(result.score).toBe(67)
    } finally {
      fake.restore()
    }
  })

  it('matches safe names case-insensitively, as PVWA does', async () => {
    const fake = recordFetch([LOGON, collection([{ safeName: 'app-PROD' }, { safeName: 'APP-legacy' }])])
    try {
      const result = await healthCheck(healthContext(SAFES))

      expect(result.healthy).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(SAFES))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('cyberark_reachable')
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })

  it('fails the reachability check when the logon itself is rejected', async () => {
    const fake = recordFetch([pvwaError(401, 'Invalid credentials')])
    try {
      const result = await healthCheck(healthContext(SAFES))

      expect(result.healthy).toBe(false)
      expect(result.checks[0].passed).toBe(false)
      expect(result.checks[0].message).toMatch('Invalid credentials')
    } finally {
      fake.restore()
    }
  })
})
