import driftDetect from '../driftDetect'
import { LOGON, driftContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const APP = item('Application 1', {
  app_id: 'AAM-Payments',
  description: 'payments service CCP identity',
  location: '\\Applications',
  authentication_methods: '[{"authType":"machineAddress","authValue":"10.0.0.7"}]',
})

const LIVE_APP = { AppID: 'AAM-Payments', Description: 'payments service CCP identity', Location: '\\Applications' }

describe('CyberArk Applications Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([APP], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the application and its auth methods match', async () => {
    const fake = recordFetch([
      LOGON,
      named('application', [LIVE_APP]),
      named('authentication', [{ AuthType: 'machineAddress', AuthValue: '10.0.0.7' }]),
    ])
    try {
      const result = await driftDetect(driftContext([APP]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted application as critical drift and reads no auth methods for it', async () => {
    const fake = recordFetch([LOGON, named('application', [])])
    try {
      const result = await driftDetect(driftContext([APP]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('AAM-Payments')
      expect(result.diffs[0].severity).toBe('critical')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports an allowed machine removed outside Veltrix as warning drift', async () => {
    const fake = recordFetch([LOGON, named('application', [LIVE_APP]), named('authentication', [])])
    try {
      const result = await driftDetect(driftContext([APP]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'AAM-Payments.authentication_methods')
      expect(diff?.expected).toBe('machineAddress:10.0.0.7')
      expect(diff?.actual).toBe('missing')
      expect(diff?.severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('reports an undeclared allowed machine added outside Veltrix as warning drift', async () => {
    const fake = recordFetch([
      LOGON,
      named('application', [LIVE_APP]),
      named('authentication', [
        { AuthType: 'machineAddress', AuthValue: '10.0.0.7' },
        { AuthType: 'machineAddress', AuthValue: '10.0.0.66' },
      ]),
    ])
    try {
      const result = await driftDetect(driftContext([APP]))

      const diff = result.diffs.find((d) => d.actual === 'machineAddress:10.0.0.66')
      expect(diff?.expected).toBe('not declared')
      expect(diff?.severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('reports a description change as informational and flags it as not auto-correctable', async () => {
    const fake = recordFetch([
      LOGON,
      named('application', [{ ...LIVE_APP, Description: 'edited in the PVWA UI' }]),
      named('authentication', [{ AuthType: 'machineAddress', AuthValue: '10.0.0.7' }]),
    ])
    try {
      const result = await driftDetect(driftContext([APP]))

      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toMatch('not auto-correctable')
      expect(result.diffs[0].severity).toBe('info')
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([APP]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
