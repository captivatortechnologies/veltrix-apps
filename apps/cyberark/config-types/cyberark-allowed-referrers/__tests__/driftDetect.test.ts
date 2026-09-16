import driftDetect from '../driftDetect'
import { LOGON, driftContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const REFERRER = item('Referrer 1', { referrer_url: 'https://portal.corp.example.com', regular_expression: false })

describe('CyberArk Allowed Referrers Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([REFERRER], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the referrer is still allowed with the declared flag', async () => {
    const fake = recordFetch([
      LOGON,
      named('AllowedReferrers', [{ referrerURL: 'https://portal.corp.example.com', regularExpression: false }]),
    ])
    try {
      const result = await driftDetect(driftContext([REFERRER]))

      expect(result.hasDrift).toBe(false)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a referrer removed outside Veltrix as critical drift', async () => {
    const fake = recordFetch([LOGON, named('AllowedReferrers', [])])
    try {
      const result = await driftDetect(driftContext([REFERRER]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('https://portal.corp.example.com')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fake.restore()
    }
  })

  it('reports a flipped regularExpression flag as informational and not auto-correctable', async () => {
    const fake = recordFetch([
      LOGON,
      named('AllowedReferrers', [{ referrerURL: 'https://portal.corp.example.com', regularExpression: true }]),
    ])
    try {
      const result = await driftDetect(driftContext([REFERRER]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toMatch('not auto-correctable')
      expect(result.diffs[0].expected).toBe(false)
      expect(result.diffs[0].actual).toBe(true)
      expect(result.diffs[0].severity).toBe('info')
    } finally {
      fake.restore()
    }
  })

  it("reads PVWA's string-valued regularExpression flag as a boolean", async () => {
    const fake = recordFetch([
      LOGON,
      named('AllowedReferrers', [{ referrerURL: 'https://portal.corp.example.com', regularExpression: 'false' }]),
    ])
    try {
      const result = await driftDetect(driftContext([REFERRER]))

      expect(result.hasDrift).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([REFERRER]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
