// =============================================================================
// brands — driftDetect, driven against the fake Okta org.
//
// Drift on a brand is somebody editing the login page out of band: the
// "Powered by Okta" footer put back, a privacy-policy link re-pointed, the
// sign-in colours changed. The tests assert each drift shape the handler
// actually compares, that an unreadable brand is REPORTED rather than thrown,
// and that detection never writes.
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

function brand(fields: Record<string, unknown> = {}): CanvasItemInput {
  return { name: 'Corporate sign-in', fields: { name: 'Acme', removePoweredByOkta: true, ...fields } }
}

const IN_SYNC = { id: 'brd-live', name: 'Acme', isDefault: true, removePoweredByOkta: true }

const LIVE_THEME = {
  id: 'thm-1',
  primaryColorHex: '#1662dd',
  primaryColorContrastHex: '#ffffff',
  signInPageTouchPointVariant: 'OKTA_DEFAULT',
}

describe('brands driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [brand()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [brand()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean brand as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [brand()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/brands')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, removePoweredByOkta: false }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [brand()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted brand as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [brand()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Acme')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags the Okta footer being restored on the sign-in page', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, removePoweredByOkta: false }])], async () =>
      driftDetect(driftContext({ sections: [brand()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Acme.removePoweredByOkta')
    expect(diff?.expected).toBe(true)
    expect(diff?.actual).toBe(false)
    expect(diff?.severity).toBe('warning')
  })

  it('treats an absent removePoweredByOkta as false rather than as "not set"', async () => {
    const result = await withFetch([ok([{ id: 'brd-live', name: 'Acme' }])], async () =>
      driftDetect(driftContext({ sections: [brand()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Acme.removePoweredByOkta')
    expect(diff?.actual).toBe(false)
  })

  it('flags a re-pointed privacy-policy URL', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, customPrivacyPolicyUrl: 'https://evil.test/privacy' }])],
      async () =>
        driftDetect(
          driftContext({ sections: [brand({ customPrivacyPolicyUrl: 'https://acme.test/privacy' })] }),
        ),
    )

    const diff = result.diffs.find((d) => d.field === 'Acme.customPrivacyPolicyUrl')
    expect(diff?.expected).toBe('https://acme.test/privacy')
    expect(diff?.actual).toBe('https://evil.test/privacy')
  })

  it('reports a cleared privacy-policy URL as "not set" rather than as absent drift', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, customPrivacyPolicyUrl: null }])], async () =>
      driftDetect(
        driftContext({ sections: [brand({ customPrivacyPolicyUrl: 'https://acme.test/privacy' })] }),
      ),
    )

    const diff = result.diffs.find((d) => d.field === 'Acme.customPrivacyPolicyUrl')
    expect(diff?.actual).toBe('not set')
  })

  it('flags a changed locale and a re-pointed email domain', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, locale: 'fr', emailDomainId: 'eml-other' }])],
      async () =>
        driftDetect(driftContext({ sections: [brand({ locale: 'en', emailDomainId: 'eml-1' })] })),
    )

    expect(result.diffs.find((d) => d.field === 'Acme.locale')?.actual).toBe('fr')
    const mail = result.diffs.find((d) => d.field === 'Acme.emailDomainId')
    expect(mail?.expected).toBe('eml-1')
    expect(mail?.actual).toBe('eml-other')
  })

  it('does not read the theme when the deployed config declares no theme change', async () => {
    await withFetch([ok([IN_SYNC])], async (calls) => {
      await driftDetect(driftContext({ sections: [brand()] }))
      expect(calls.some((c) => c.path.includes('/themes'))).toBe(false)
    })
  })

  it('flags a theme colour changed out of band', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), ok([{ ...LIVE_THEME, primaryColorHex: '#ff0000' }])],
      async (calls) => {
        const res = await driftDetect(driftContext({ sections: [brand({ primaryColorHex: '#1662dd' })] }))
        expect(calls[1].path).toBe('/brands/brd-live/themes')
        return res
      },
    )

    const diff = result.diffs.find((d) => d.field === 'Acme.primaryColorHex')
    expect(diff?.expected).toBe('#1662dd')
    expect(diff?.actual).toBe('#ff0000')
    expect(diff?.severity).toBe('warning')
  })

  it('does not call a colour drifted just because its hex case differs', async () => {
    const result = await withFetch([ok([IN_SYNC]), ok([LIVE_THEME])], async () =>
      driftDetect(driftContext({ sections: [brand({ primaryColorHex: '#1662DD' })] })),
    )

    expect(result.diffs.filter((d) => d.field === 'Acme.primaryColorHex')).toHaveLength(0)
  })

  it('reports a missing theme colour as "not set" rather than throwing', async () => {
    const result = await withFetch([ok([IN_SYNC]), EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [brand({ primaryColorHex: '#1662dd' })] })),
    )

    expect(result.diffs.find((d) => d.field === 'Acme.primaryColorHex')?.actual).toBe('not set')
  })

  it('flags a changed touchpoint variant from the declared variants blob', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), ok([{ ...LIVE_THEME, signInPageTouchPointVariant: 'BACKGROUND_IMAGE' }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [brand({ themeConfigJson: '{"signInPageTouchPointVariant":"OKTA_DEFAULT"}' })],
          }),
        ),
    )

    const diff = result.diffs.find((d) => d.field === 'Acme.signInPageTouchPointVariant')
    expect(diff?.expected).toBe('OKTA_DEFAULT')
    expect(diff?.actual).toBe('BACKGROUND_IMAGE')
  })

  it('never reports the logo Okta manages as drift', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), ok([{ ...LIVE_THEME, logo: 'https://cdn.example.test/other.png' }])],
      async () => driftDetect(driftContext({ sections: [brand({ primaryColorHex: '#1662dd' })] })),
    )

    expect(result.diffs.filter((d) => d.field.includes('logo'))).toHaveLength(0)
    expect(result.hasDrift).toBe(false)
  })

  it('reports an unreadable brand list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [brand()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Acme')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports an unreadable theme as critical drift instead of throwing', async () => {
    const result = await withFetch(
      [ok([IN_SYNC]), apiError('Insufficient permissions', 403)],
      async () => driftDetect(driftContext({ sections: [brand({ primaryColorHex: '#1662dd' })] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/Failed to list themes/)
  })

  it('keeps reporting the remaining brands after one is unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), EMPTY_LIST],
      async () =>
        driftDetect(
          driftContext({ sections: [brand(), { name: 'Partner sign-in', fields: { name: 'Partner' } }] }),
        ),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('Partner')
    expect(result.diffs[1].actual).toBe('missing')
  })
})
