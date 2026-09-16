// =============================================================================
// device-assurance-policies — driftDetect, driven against the fake Okta org.
//
// Drift here is a posture requirement quietly relaxed: encryption no longer
// required, a jailbroken phone allowed back in. Every requirement key the canvas
// declares is compared; keys Okta adds of its own accord are not. Detection must
// never write, and an unreadable org is a reported diff, not a crash.
// =============================================================================

import driftDetect from '../driftDetect'
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

const CONFIG_JSON =
  '{"diskEncryptionType":{"include":["FULL"]},"screenLockType":{"include":["BIOMETRIC"]}}'

function assurance(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Managed macOS',
    fields: { name: 'Managed macOS', platform: 'MACOS', configJson: CONFIG_JSON, ...fields },
  }
}

const IN_SYNC = {
  id: 'dap-1',
  name: 'Managed macOS',
  platform: 'MACOS',
  diskEncryptionType: { include: ['FULL'] },
  screenLockType: { include: ['BIOMETRIC'] },
}

describe('device-assurance-policies driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [assurance()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [assurance()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean policy as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [assurance()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/device-assurances')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, screenLockType: { include: ['NONE'] } }])], async (calls) => {
      await driftDetect(driftContext({ sections: [assurance()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted policy as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [assurance()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Managed macOS')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a relaxed requirement — the posture-gate-disabled shape', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, screenLockType: { include: ['NONE'] } }])],
      async () => driftDetect(driftContext({ sections: [assurance()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Managed macOS.screenLockType')
    expect(diff?.expected).toEqual({ include: ['BIOMETRIC'] })
    expect(diff?.actual).toEqual({ include: ['NONE'] })
    expect(diff?.severity).toBe('critical')
  })

  it('flags a requirement that was removed from the live policy altogether', async () => {
    const live = { id: 'dap-1', name: 'Managed macOS', platform: 'MACOS', screenLockType: { include: ['BIOMETRIC'] } }

    const result = await withFetch([ok([live])], async () =>
      driftDetect(driftContext({ sections: [assurance()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Managed macOS.diskEncryptionType')
    expect(diff?.actual).toBe('not set')
  })

  it('ignores key order inside a requirement — only the value matters', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, diskEncryptionType: { include: ['FULL'] } }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              assurance({
                configJson: '{"screenLockType":{"include":["BIOMETRIC"]},"diskEncryptionType":{"include":["FULL"]}}',
              }),
            ],
          }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('does not compare requirement keys the canvas never declared', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, jailbreak: false, osVersion: { minimum: '14.0' } }])],
      async () => driftDetect(driftContext({ sections: [assurance()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a changed platform as critical drift', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, platform: 'IOS' }])], async () =>
      driftDetect(driftContext({ sections: [assurance()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Managed macOS.platform')
    expect(diff?.expected).toBe('MACOS')
    expect(diff?.actual).toBe('IOS')
    expect(diff?.severity).toBe('critical')
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [assurance()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Managed macOS')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining policies after one read fails', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, platform: 'IOS' }])],
      async () =>
        driftDetect(
          driftContext({ sections: [assurance({ name: 'Managed Windows' }), assurance()] }),
        ),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[0].field).toBe('Managed Windows')
    expect(result.diffs[1].field).toBe('Managed macOS.platform')
  })

  it('still compares the platform when the canvas declares no requirements', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, platform: 'IOS' }])], async () =>
      driftDetect(driftContext({ sections: [assurance({ configJson: '' })] })),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Managed macOS.platform')
  })

  it('ignores a section with no name or platform', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Blank', fields: { name: '', platform: '' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
