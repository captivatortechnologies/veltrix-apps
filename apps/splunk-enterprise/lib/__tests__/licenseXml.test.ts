import { parseSplunkLicenseXml, deriveLicenseStatus, EXPIRING_SOON_DAYS } from '../licenseXml'

const DAY = 24 * 60 * 60 * 1000

/** Build a license XML with a given expiration epoch (seconds). */
function licenseXml(opts: {
  label?: string
  type?: string
  groupId?: string
  stackId?: string
  quota?: number
  windowPeriod?: number
  maxViolations?: number
  creation?: number
  expiration?: number
  guid?: string
  features?: string[]
}): string {
  const features = (opts.features ?? ['Auth', 'FwdData'])
    .map((f) => `<feature>${f}</feature>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<license>
  <signature>c2lnbmF0dXJlLWJhc2U2NA==</signature>
  <payload>
    <type>${opts.type ?? 'enterprise'}</type>
    <group_id>${opts.groupId ?? 'Enterprise'}</group_id>
    <label>${opts.label ?? 'Acme Prod License'}</label>
    <quota>${opts.quota ?? 536870912000}</quota>
    <max_violations>${opts.maxViolations ?? 5}</max_violations>
    <window_period>${opts.windowPeriod ?? 30}</window_period>
    <creation_time>${opts.creation ?? 1704067200}</creation_time>
    <expiration_time>${opts.expiration ?? 1735689600}</expiration_time>
    <features>${features}</features>
    <sourcetypes/>
    <guid>${opts.guid ?? '7E7DB4A0-1111-2222-3333-444455556666'}</guid>
    <stack_id>${opts.stackId ?? 'enterprise'}</stack_id>
  </payload>
</license>`
}

describe('parseSplunkLicenseXml', () => {
  it('extracts every payload field from a realistic license', () => {
    const { data, error } = parseSplunkLicenseXml(
      licenseXml({ label: 'Acme Prod &amp; DR License', quota: 536870912000 }),
    )
    expect(error).toBeUndefined()
    expect(data!.label).toBe('Acme Prod & DR License') // XML entity decoded
    expect(data!.licenseType).toBe('enterprise')
    expect(data!.groupId).toBe('Enterprise')
    expect(data!.stackId).toBe('enterprise')
    expect(data!.quotaBytes).toBe(536870912000)
    expect(data!.windowPeriod).toBe(30)
    expect(data!.maxViolations).toBe(5)
    expect(data!.guid).toBe('7E7DB4A0-1111-2222-3333-444455556666')
    expect(data!.features).toEqual(['Auth', 'FwdData'])
    expect(data!.creationTime!.getTime()).toBe(1704067200 * 1000)
    expect(data!.expirationTime!.getTime()).toBe(1735689600 * 1000)
  })

  it('handles a single feature and does not confuse <sourcetypes/> with <type>', () => {
    const { data } = parseSplunkLicenseXml(licenseXml({ features: ['Auth'], type: 'forwarder' }))
    expect(data!.features).toEqual(['Auth'])
    expect(data!.licenseType).toBe('forwarder')
  })

  it('tolerates leading/trailing whitespace (a wrapping .lic file)', () => {
    const { data, error } = parseSplunkLicenseXml('\n\n  ' + licenseXml({}) + '  \n')
    expect(error).toBeUndefined()
    expect(data!.stackId).toBe('enterprise')
  })

  it('rejects empty input', () => {
    expect(parseSplunkLicenseXml('').error).toBe('License XML is required')
    expect(parseSplunkLicenseXml('   ').error).toBe('License XML is required')
  })

  it('rejects a document with no <payload>', () => {
    expect(parseSplunkLicenseXml('<license><signature/></license>').error).toMatch(/no <payload>/)
  })
})

describe('deriveLicenseStatus', () => {
  const now = new Date('2026-07-20T00:00:00Z')

  it('marks a license far from expiry as active', () => {
    const exp = new Date(now.getTime() + 100 * DAY)
    const { status, daysToExpiry } = deriveLicenseStatus(exp, now)
    expect(status).toBe('active')
    expect(daysToExpiry).toBe(100)
  })

  it(`marks a license within ${EXPIRING_SOON_DAYS} days as expiring-soon`, () => {
    const exp = new Date(now.getTime() + 10 * DAY)
    const { status, daysToExpiry } = deriveLicenseStatus(exp, now)
    expect(status).toBe('expiring-soon')
    expect(daysToExpiry).toBe(10)
  })

  it('marks a past license as expired with a negative daysToExpiry', () => {
    const exp = new Date(now.getTime() - 5 * DAY)
    const { status, daysToExpiry } = deriveLicenseStatus(exp, now)
    expect(status).toBe('expired')
    expect(daysToExpiry).toBe(-5)
  })

  it('returns unknown when there is no expiration', () => {
    const { status, daysToExpiry } = deriveLicenseStatus(null, now)
    expect(status).toBe('unknown')
    expect(daysToExpiry).toBeNull()
  })
})

// The end-to-end scenario the feature must handle: three parsed licenses whose
// expirations land active / expiring-soon / expired relative to "now".
describe('parse + status together', () => {
  const now = new Date('2026-07-20T00:00:00Z')
  const epoch = (offsetDays: number) => Math.floor((now.getTime() + offsetDays * DAY) / 1000)

  it('classifies active, expiring-soon and expired licenses', () => {
    const active = parseSplunkLicenseXml(licenseXml({ expiration: epoch(200), guid: 'A' })).data!
    const soon = parseSplunkLicenseXml(licenseXml({ expiration: epoch(7), guid: 'B' })).data!
    const expired = parseSplunkLicenseXml(licenseXml({ expiration: epoch(-1), guid: 'C' })).data!

    expect(deriveLicenseStatus(active.expirationTime, now).status).toBe('active')
    expect(deriveLicenseStatus(soon.expirationTime, now).status).toBe('expiring-soon')
    expect(deriveLicenseStatus(expired.expirationTime, now).status).toBe('expired')
  })
})
