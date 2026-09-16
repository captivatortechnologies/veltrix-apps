import healthCheck from '../healthCheck'
import { API_URL, LOGON, healthContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const REFERRERS = [
  item('Referrer 1', { referrer_url: 'https://portal.corp.example.com' }),
  item('Referrer 2', { referrer_url: 'https://reports.corp.example.com' }),
]

describe('CyberArk Allowed Referrers Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(REFERRERS, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared referrer is still allowed', async () => {
    const fake = recordFetch([
      LOGON,
      named('AllowedReferrers', [
        { referrerURL: 'https://portal.corp.example.com' },
        { referrerURL: 'https://reports.corp.example.com' },
      ]),
    ])
    try {
      const result = await healthCheck(healthContext(REFERRERS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(vendorCalls(fake.calls)[0].url).toBe(`${API_URL}/Configuration/AccessRestriction/AllowedReferrers`)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific referrer that has been removed', async () => {
    const fake = recordFetch([LOGON, named('AllowedReferrers', [{ referrerURL: 'https://portal.corp.example.com' }])])
    try {
      const result = await healthCheck(healthContext(REFERRERS))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'referrer:https://reports.corp.example.com')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(REFERRERS))

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
