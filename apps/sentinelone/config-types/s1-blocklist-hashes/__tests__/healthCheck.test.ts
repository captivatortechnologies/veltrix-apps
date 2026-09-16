import healthCheck from '../healthCheck'
import { RESTRICTION_TYPE } from '../validate'
import {
  SCOPELESS_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-blocklist-hashes'
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
const OTHER_SHA1 = '0123456789abcdef0123456789abcdef01234567'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const malware: CanvasItemInput = { name: 'Hash 1', fields: { sha1: SHA1, os_type: 'windows' } }
const dropper: CanvasItemInput = { name: 'Hash 2', fields: { sha1: OTHER_SHA1, os_type: 'windows' } }

describe('SentinelOne Blocklist Hashes Health Check Handler', () => {
  it('fails closed without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(healthContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].name).toBe('s1_credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx([malware], SCOPELESS_SETTINGS))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('checks presence against the black_hash restrictions only', async () => {
    await withFetch([envelope([{ id: 'res-1', value: SHA1, osType: 'windows' }])], async (calls) => {
      const result = await healthCheck(ctx([malware]))

      expect(calls[0].url).toContain(`type=${RESTRICTION_TYPE}`)
      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
    })
  })

  it('reports the specific hash that is no longer blocklisted', async () => {
    await withFetch([envelope([{ id: 'res-1', value: SHA1, osType: 'windows' }])], async () => {
      const result = await healthCheck(ctx([malware, dropper]))

      expect(result.healthy).toBe(false)
      const failed = result.checks.filter((check) => !check.passed)
      expect(failed).toHaveLength(1)
      expect(failed[0].name).toContain(OTHER_SHA1)
    })
  })

  it('matches a live hash regardless of its case', async () => {
    await withFetch(
      [envelope([{ id: 'res-1', value: SHA1.toUpperCase(), osType: 'windows' }])],
      async () => {
        const result = await healthCheck(ctx([malware]))
        expect(result.healthy).toBe(true)
      },
    )
  })

  it('reports an unreachable console as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([malware]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_reachable')
    })
  })
})
