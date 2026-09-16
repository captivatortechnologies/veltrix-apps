import healthCheck from '../healthCheck'
import { RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE } from '../validate'
import {
  SCOPELESS_SETTINGS,
  apiError,
  envelope,
  healthContext,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-notification-recipients'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return healthContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

const soc: CanvasItemInput = { name: 'Recipient 1', fields: { email: 'soc@example.com' } }
const onCall: CanvasItemInput = { name: 'Recipient 2', fields: { email: 'oncall@example.com' } }

describe('SentinelOne Notification Recipients Health Check Handler', () => {
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
      const result = await healthCheck(ctx([soc], SCOPELESS_SETTINGS))
      expect(result.checks[0].name).toBe('s1_scope')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed at the unsupported group scope', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(ctx([soc], { scope: 'group', scope_id: 'grp-1' }))
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toBe(RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE)
      expect(calls).toHaveLength(0)
    })
  })

  it('scores 100 when every declared recipient is present at the scope', async () => {
    await withFetch(
      [envelope([{ id: 'rcp-1', email: 'soc@example.com' }, { id: 'rcp-2', email: 'oncall@example.com' }])],
      async () => {
        const result = await healthCheck(ctx([soc, onCall]))
        expect(result.healthy).toBe(true)
        expect(result.score).toBe(100)
        expect(result.checks).toHaveLength(3)
      },
    )
  })

  it('reports the specific recipient that has been removed', async () => {
    await withFetch([envelope([{ id: 'rcp-1', email: 'soc@example.com' }])], async () => {
      const result = await healthCheck(ctx([soc, onCall]))

      expect(result.healthy).toBe(false)
      const failed = result.checks.filter((check) => !check.passed)
      expect(failed).toHaveLength(1)
      expect(failed[0].name).toBe('recipient:oncall@example.com')
    })
  })

  it('matches a live recipient whose email differs only by case', async () => {
    await withFetch([envelope([{ id: 'rcp-1', email: 'SOC@Example.com' }])], async () => {
      const result = await healthCheck(ctx([soc]))
      expect(result.healthy).toBe(true)
    })
  })

  it('reports an unreachable console as an unhealthy check rather than throwing', async () => {
    await withFetch([apiError('service unavailable', 503)], async () => {
      const result = await healthCheck(ctx([soc]))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('s1_reachable')
    })
  })
})
