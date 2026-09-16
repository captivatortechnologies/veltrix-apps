// =============================================================================
// captcha — driftDetect, driven against the fake Okta org.
//
// The drift that matters is the gate being quietly taken off the door: pages
// removed from the org-wide enablement, the org re-pointed at a different
// instance, the site key swapped for one the provider will not verify. The
// write-only secret key is never modeled, so it can never read as drift — and
// can never turn up in a diff an operator reads in the UI.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  EMPTY_LIST,
  apiError,
  driftContext,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const SECRET_KEY = 'hcaptcha-SUPERSECRET-provider-secret'

function captcha(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Sign-in CAPTCHA',
    fields: {
      name: 'Acme hCaptcha',
      type: 'HCAPTCHA',
      siteKey: 'site-key-public',
      secretKey: SECRET_KEY,
      enabledPages: ['SIGN_IN'],
      ...fields,
    },
  }
}

const LIVE_INSTANCE = { id: 'cap-live', name: 'Acme hCaptcha', type: 'HCAPTCHA', siteKey: 'site-key-public' }
const LIVE_ORG = { captchaId: 'cap-live', enabledPages: ['SIGN_IN'] }

function leaksSecret(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('SUPERSECRET-provider-secret')
}

describe('captcha driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [captcha()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [captcha()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when nothing was deployed', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [] }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean CAPTCHA as in sync', async () => {
    const result = await withFetch([ok([LIVE_INSTANCE]), ok(LIVE_ORG)], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [captcha()] }))
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe('/captchas')
      expect(calls[1].path).toBe('/org/captcha')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...LIVE_INSTANCE, siteKey: 'swapped' }]), ok(LIVE_ORG)], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [captcha()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted instance as critical and stops there', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [captcha()] }))
      // Nothing left to compare the org settings against.
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('captcha')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a renamed instance as a warning', async () => {
    const result = await withFetch([ok([{ ...LIVE_INSTANCE, name: 'Renamed' }]), ok(LIVE_ORG)], async () =>
      driftDetect(driftContext({ sections: [captcha()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'name')
    expect(diff?.expected).toBe('Acme hCaptcha')
    expect(diff?.actual).toBe('Renamed')
    expect(diff?.severity).toBe('warning')
  })

  it('flags a swapped provider as critical', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE_INSTANCE, type: 'RECAPTCHA_V2' }]), ok(LIVE_ORG)],
      async () => driftDetect(driftContext({ sections: [captcha()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'type')
    expect(diff?.expected).toBe('HCAPTCHA')
    expect(diff?.actual).toBe('RECAPTCHA_V2')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a swapped site key as critical — the gate stops verifying', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE_INSTANCE, siteKey: 'attacker-site-key' }]), ok(LIVE_ORG)],
      async () => driftDetect(driftContext({ sections: [captcha()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'siteKey')
    expect(diff?.expected).toBe('site-key-public')
    expect(diff?.actual).toBe('attacker-site-key')
    expect(diff?.severity).toBe('critical')
  })

  it('reports a missing site key as "not set" rather than as an empty string', async () => {
    const result = await withFetch(
      [ok([{ id: 'cap-live', name: 'Acme hCaptcha', type: 'HCAPTCHA' }]), ok(LIVE_ORG)],
      async () => driftDetect(driftContext({ sections: [captcha()] })),
    )

    expect(result.diffs.find((d) => d.field === 'siteKey')?.actual).toBe('not set')
  })

  it('flags the gate being taken off a page', async () => {
    const result = await withFetch(
      [ok([LIVE_INSTANCE]), ok({ captchaId: 'cap-live', enabledPages: [] })],
      async () => driftDetect(driftContext({ sections: [captcha()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'enabledPages')
    expect(diff?.expected).toEqual(['SIGN_IN'])
    expect(diff?.actual).toEqual([])
    expect(diff?.severity).toBe('warning')
  })

  it('does not call a reordered page list drift', async () => {
    const result = await withFetch(
      [ok([LIVE_INSTANCE]), ok({ captchaId: 'cap-live', enabledPages: ['SSPR', 'SIGN_IN'] })],
      async () => driftDetect(driftContext({ sections: [captcha({ enabledPages: ['SIGN_IN', 'SSPR'] })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('treats an absent org enablement as no pages rather than throwing', async () => {
    const result = await withFetch([ok([LIVE_INSTANCE]), ok({})], async () =>
      driftDetect(driftContext({ sections: [captcha()] })),
    )

    expect(result.diffs.find((d) => d.field === 'enabledPages')?.actual).toEqual([])
  })

  it('flags the org pointing at a different CAPTCHA instance as critical', async () => {
    const result = await withFetch(
      [ok([LIVE_INSTANCE]), ok({ captchaId: 'cap-other', enabledPages: ['SIGN_IN'] })],
      async () => driftDetect(driftContext({ sections: [captcha()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'org.captchaId')
    expect(diff?.expected).toBe('cap-live')
    expect(diff?.actual).toBe('cap-other')
    expect(diff?.severity).toBe('critical')
  })

  it('does not demand an org binding when the deployed config enables no pages', async () => {
    const result = await withFetch(
      [ok([LIVE_INSTANCE]), ok({ captchaId: null, enabledPages: null })],
      async () => driftDetect(driftContext({ sections: [captcha({ enabledPages: [] })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('never reports the write-only secret key as drift', async () => {
    const result = await withFetch([ok([LIVE_INSTANCE]), ok(LIVE_ORG)], async () =>
      driftDetect(driftContext({ sections: [captcha()] })),
    )

    // Okta never returns the secret, so a diff on it would fire on every run —
    // and would put the secret itself in front of whoever reads the drift report.
    expect(result.diffs.filter((d) => d.field.toLowerCase().includes('secret'))).toHaveLength(0)
    expect(leaksSecret(result)).toBe(false)
  })

  it('reports an unreadable org as a single critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [captcha()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('captcha')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
    expect(leaksSecret(result)).toBe(false)
  })

  it('reports unreadable org-wide settings as critical drift too', async () => {
    const result = await withFetch(
      [ok([LIVE_INSTANCE]), apiError('Insufficient permissions', 403)],
      async () => driftDetect(driftContext({ sections: [captcha()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(String(result.diffs[0].actual)).toMatch(/Failed to read org-wide CAPTCHA settings/)
  })
})
