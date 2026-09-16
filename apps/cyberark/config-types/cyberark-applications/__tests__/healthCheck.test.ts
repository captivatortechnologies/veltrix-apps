import healthCheck from '../healthCheck'
import { LEGACY_URL, LOGON, healthContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const APPS = [item('Application 1', { app_id: 'AAM-Payments' }), item('Application 2', { app_id: 'AAM-Reporting' })]

describe('CyberArk Applications Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(APPS, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared application is present', async () => {
    const fake = recordFetch([LOGON, named('application', [{ AppID: 'AAM-Payments' }, { AppID: 'AAM-Reporting' }])])
    try {
      const result = await healthCheck(healthContext(APPS))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(vendorCalls(fake.calls)[0].url).toBe(`${LEGACY_URL}/Applications/`)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific application that has gone missing', async () => {
    const fake = recordFetch([LOGON, named('application', [{ AppID: 'AAM-Payments' }])])
    try {
      const result = await healthCheck(healthContext(APPS))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'application:AAM-Reporting')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(APPS))

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
