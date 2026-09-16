import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  driftContext,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'watchlists'
const WATCHLISTS = `/threathunter/watchlistmgr/v3/orgs/${ORG_KEY}/watchlists`

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function watchlist(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.name ?? ''), fields }
}

const DEPLOYED = watchlist({
  name: 'Ransomware',
  description: 'ioc feed',
  feedId: 'FID1',
  tags_enabled: true,
  alerts_enabled: true,
})

const IN_SYNC = {
  id: 'wl-1',
  name: 'Ransomware',
  description: 'ioc feed',
  tags_enabled: true,
  alerts_enabled: true,
  classifier: { key: 'feed_id', value: 'FID1' },
}

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black watchlists driftDetect handler', () => {
  it('reports no drift without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when the live watchlist matches what was deployed', async () => {
    await withFetch([cbJson({ results: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(WATCHLISTS)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted watchlist as critical — the endpoints it covered are unprotected', async () => {
    await withFetch([EMPTY_LIST], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Ransomware')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags alerting turned off out of band', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, alerts_enabled: false }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(fields(result)).toContain('Ransomware.alerts_enabled')
      const diff = result.diffs.find((d) => d.field === 'Ransomware.alerts_enabled')!
      expect(diff.expected).toBe(true)
      expect(diff.actual).toBe(false)
    })
  })

  it('flags the watchlist being repointed at a different feed', async () => {
    await withFetch(
      [cbJson({ results: [{ ...IN_SYNC, classifier: { key: 'feed_id', value: 'OTHER' } }] })],
      async () => {
        const result = await driftDetect(ctx([DEPLOYED]))

        expect(result.hasDrift).toBe(true)
        const diff = result.diffs.find((d) => d.field === 'Ransomware.feedId')!
        expect(diff.expected).toBe('FID1')
        expect(diff.actual).toBe('OTHER')
      },
    )
  })

  it('flags description and tagging drift together', async () => {
    await withFetch(
      [cbJson({ results: [{ ...IN_SYNC, description: 'edited', tags_enabled: false }] })],
      async () => {
        const result = await driftDetect(ctx([DEPLOYED]))

        expect(result.hasDrift).toBe(true)
        expect(fields(result)).toContain('Ransomware.description')
        expect(fields(result)).toContain('Ransomware.tags_enabled')
      },
    )
  })

  it('matches the live watchlist by name case-insensitively', async () => {
    await withFetch([cbJson({ results: [{ ...IN_SYNC, name: 'RANSOMWARE' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('reports no drift when the vendor listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })
})
