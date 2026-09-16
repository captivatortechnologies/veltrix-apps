import rollback from '../rollback'
import { apiError, dataOf, envelope, rollbackContext, withFetch } from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-agent-policy'
const POLICY_PATH = '/accounts/act-1/policy'

function ctx(data: unknown, settings?: Record<string, unknown>) {
  return rollbackContext(data, { configTypeId: CONFIG_TYPE, settings })
}

const priorPolicy = { agentUi: { agentUiOn: false }, threats: { autoMitigate: true } }

describe('SentinelOne Agent Policy Rollback Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ priorPolicy, path: POLICY_PATH }, {
          configTypeId: CONFIG_TYPE,
          credential: null,
        }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports failure and touches nothing when no prior policy was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({}))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No previous policy available for rollback')
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the whole prior policy to the captured path', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx({ priorPolicy, path: POLICY_PATH }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(POLICY_PATH)
      expect(dataOf(calls[0])).toEqual(priorPolicy)
    })
  })

  it('strips the deprecated top-level keys from the restore body', async () => {
    const withDeprecated = { ...priorPolicy, agentNotification: { x: 1 }, agentUiOn: true }
    await withFetch([envelope({})], async (calls) => {
      await rollback(ctx({ priorPolicy: withDeprecated, path: POLICY_PATH }))

      expect(dataOf(calls[0])).toEqual(priorPolicy)
    })
  })

  it('falls back to the scope\'s policy path when none was captured', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx({ priorPolicy }))

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe(POLICY_PATH)
    })
  })

  it('reports failure and touches nothing when no policy path can be resolved', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ priorPolicy }, { scope: 'global' }))

      expect(result.success).toBe(false)
      expect(result.message).toBe('Could not resolve the policy path for rollback')
      expect(calls).toHaveLength(0)
    })
  })

  it('reports failure rather than throwing when the restore is rejected', async () => {
    await withFetch([apiError('policy is locked', 409)], async () => {
      const result = await rollback(ctx({ priorPolicy, path: POLICY_PATH }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/policy is locked/)
    })
  })
})
