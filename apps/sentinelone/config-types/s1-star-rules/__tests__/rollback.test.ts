import rollback from '../rollback'
import type { StarRuleRollbackEntry } from '../deploy'
import {
  SCOPELESS_SETTINGS,
  apiError,
  callsTo,
  dataOf,
  envelope,
  filterOf,
  rollbackContext,
  withFetch,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-star-rules'
const RULES = '/cloud-detection/rules'

function ctx(previousState: StarRuleRollbackEntry[] | undefined, settings?: Record<string, unknown>) {
  return rollbackContext(previousState === undefined ? {} : { previousState }, {
    configTypeId: CONFIG_TYPE,
    settings,
  })
}

const created: StarRuleRollbackEntry = {
  key: 'suspicious powershell',
  label: 'Suspicious PowerShell',
  existed: false,
  id: 'rule-new',
}

const updated: StarRuleRollbackEntry = {
  key: 'legacy hunt',
  label: 'Legacy hunt',
  existed: true,
  id: 'rule-1',
  prior: {
    id: 'rule-1',
    name: 'Legacy hunt',
    description: 'original',
    s1ql: 'old query',
    queryType: 'events',
    severity: 'Low',
    status: 'Active',
    queryLang: '2.0',
  },
}

describe('SentinelOne STAR Rules Rollback Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created] }, { configTypeId: CONFIG_TYPE, credential: null }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([updated], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports failure and touches nothing when there is no previous state', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No previous state available for rollback')
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a rule the deploy created, targeted by id', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx([created]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(RULES)
      expect(filterOf(calls[0])).toEqual({ ids: ['rule-new'] })
    })
  })

  it('restores an updated rule and re-activates it to match its prior status', async () => {
    await withFetch([envelope({}), envelope({})], async (calls) => {
      const result = await rollback(ctx([updated]))

      expect(result.success).toBe(true)
      const puts = callsTo(calls, `${RULES}/rule-1`)
      expect(puts).toHaveLength(1)
      expect(dataOf(puts[0])).toEqual({
        name: 'Legacy hunt',
        description: 'original',
        s1ql: 'old query',
        queryType: 'events',
        severity: 'Low',
        status: 'Draft',
        networkQuarantine: false,
        expirationMode: 'Permanent',
        queryLang: '2.0',
      })
      // The rule was Active before the deploy, so restoring the body is not enough.
      expect(callsTo(calls, `${RULES}/enable`)).toHaveLength(1)
    })
  })

  it('leaves a rule that was a Draft before the deploy disabled', async () => {
    const wasDraft: StarRuleRollbackEntry = {
      ...updated,
      prior: { ...updated.prior, status: 'Draft' },
    }
    await withFetch([envelope({}), envelope({})], async (calls) => {
      await rollback(ctx([wasDraft]))

      expect(callsTo(calls, `${RULES}/disable`)).toHaveLength(1)
      expect(callsTo(calls, `${RULES}/enable`)).toHaveLength(0)
    })
  })

  it('treats a rule already deleted out-of-band (404) as reverted', async () => {
    await withFetch([apiError('not found', 404)], async () => {
      const result = await rollback(ctx([created]))
      expect(result.success).toBe(true)
    })
  })

  it('reports failure rather than throwing when a restore is rejected', async () => {
    await withFetch([apiError('access denied', 403)], async () => {
      const result = await rollback(ctx([updated]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/access denied/)
    })
  })
})
