// =============================================================================
// log-streams — driftDetect, driven against the fake Okta org.
//
// Drift on a log stream is the audit trail being redirected or switched off out
// of band — a deleted stream, an AWS account id pointed somewhere else, a stream
// quietly deactivated. The Splunk HEC token is write-only and never returned, so
// comparing it would report drift on every single run; it must be skipped.
// =============================================================================

import driftDetect from '../driftDetect'
import type { LiveLogStream } from '../validate'
import {
  apiError,
  driftContext,
  EMPTY_LIST,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const HEC_TOKEN = 'splunk-hec-SUPERSECRET-token'

const AWS_SETTINGS = {
  accountId: '123456789012',
  eventSourceName: 'okta-events',
  region: 'us-east-1',
}

function stream(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Audit export',
    fields: {
      name: 'Veltrix audit export',
      type: 'aws_eventbridge',
      status: 'ACTIVE',
      settingsJson: JSON.stringify(AWS_SETTINGS),
      ...fields,
    },
  }
}

const IN_SYNC: LiveLogStream = {
  id: 'lsLIVE',
  name: 'Veltrix audit export',
  type: 'aws_eventbridge',
  status: 'ACTIVE',
  settings: { ...AWS_SETTINGS },
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
}

const withSettings = (settings: Record<string, unknown>): LiveLogStream => ({
  ...IN_SYNC,
  settings: { ...IN_SYNC.settings, ...settings },
})

describe('log-streams driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [stream()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [stream()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean stream as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [stream()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/logStreams')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([withSettings({ region: 'eu-west-1' })])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [stream()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted stream as critical drift — the audit trail has ended', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [stream()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Veltrix audit export')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a changed destination type as critical drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, type: 'splunk_cloud_logstreaming' }])],
      async () => driftDetect(driftContext({ sections: [stream()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit export.type')
    expect(diff?.expected).toBe('aws_eventbridge')
    expect(diff?.actual).toBe('splunk_cloud_logstreaming')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a re-pointed AWS account — the log-exfiltration shape', async () => {
    const result = await withFetch([ok([withSettings({ accountId: '999999999999' })])], async () =>
      driftDetect(driftContext({ sections: [stream()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit export.settings.accountId')
    expect(diff?.expected).toBe('123456789012')
    expect(diff?.actual).toBe('999999999999')
    expect(diff?.severity).toBe('critical')
  })

  it('reports a settings key that vanished from the live stream as "not set"', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, settings: { accountId: '123456789012', region: 'us-east-1' } }])],
      async () => driftDetect(driftContext({ sections: [stream()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit export.settings.eventSourceName')
    expect(diff?.expected).toBe('okta-events')
    expect(diff?.actual).toBe('not set')
  })

  it('never compares the write-only Splunk token, so a live stream without it is in sync', async () => {
    const declared = JSON.stringify({
      host: 'http-inputs-acme.splunkcloud.com',
      edition: 'aws',
      token: HEC_TOKEN,
    })
    const liveSplunk: LiveLogStream = {
      ...IN_SYNC,
      type: 'splunk_cloud_logstreaming',
      settings: { host: 'http-inputs-acme.splunkcloud.com', edition: 'aws' },
    }

    const result = await withFetch([ok([liveSplunk])], async () =>
      driftDetect(
        driftContext({
          sections: [stream({ type: 'splunk_cloud_logstreaming', settingsJson: declared })],
        }),
      ),
    )

    expect(result.hasDrift).toBe(false)
    expect(JSON.stringify(result).includes(HEC_TOKEN)).toBe(false)
  })

  it('ignores a live settings key the canvas never declared', async () => {
    const result = await withFetch([ok([withSettings({ extraVendorField: 'whatever' })])], async () =>
      driftDetect(driftContext({ sections: [stream()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('does not read a re-ordered nested settings object as drift', async () => {
    const declared = JSON.stringify({ ...AWS_SETTINGS, tags: { env: 'prod', owner: 'secops' } })
    const result = await withFetch(
      [ok([withSettings({ tags: { owner: 'secops', env: 'prod' } })])],
      async () => driftDetect(driftContext({ sections: [stream({ settingsJson: declared })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a stream switched off out of band as a warning, not a critical', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [stream()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit export.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('does not flag server-managed fields such as lastUpdated', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, lastUpdated: '2026-09-09T00:00:00.000Z' }])],
      async () => driftDetect(driftContext({ sections: [stream()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports an unreadable stream list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [stream()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].severity).toBe('critical')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].actual).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining streams after one becomes unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, name: 'Second export' }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [stream(), { name: 'Second', fields: { ...stream({ name: 'Second export' }).fields } }],
          }),
        ),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Veltrix audit export')
  })

  it('makes no System Log call — this config type attaches no drift actor', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [stream()] }))

      expect(result.hasDrift).toBe(true)
      expect(calls.some((c) => c.path === '/logs')).toBe(false)
      expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
    })
  })
})
