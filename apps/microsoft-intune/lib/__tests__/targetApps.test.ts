import { buildTargetApps, readTargetedAppIds } from '../targetApps'

describe('buildTargetApps', () => {
  it('builds iOS bundleId identifiers for selectedPublicApps', () => {
    const body = buildTargetApps({
      platform: 'ios',
      appIds: ['com.microsoft.office.outlook'],
      appGroupType: 'selectedPublicApps',
    })
    expect(body.appGroupType).toBe('selectedPublicApps')
    expect(body.apps).toHaveLength(1)
    expect(body.apps[0].mobileAppIdentifier['@odata.type']).toBe('#microsoft.graph.iosMobileAppIdentifier')
    expect(body.apps[0].mobileAppIdentifier.bundleId).toBe('com.microsoft.office.outlook')
  })

  it('builds Android packageId identifiers', () => {
    const body = buildTargetApps({
      platform: 'android',
      appIds: ['com.microsoft.office.outlook'],
      appGroupType: 'selectedPublicApps',
    })
    expect(body.apps[0].mobileAppIdentifier['@odata.type']).toBe('#microsoft.graph.androidMobileAppIdentifier')
    expect(body.apps[0].mobileAppIdentifier.packageId).toBe('com.microsoft.office.outlook')
  })

  it('sends no apps for an all-* app group type', () => {
    const body = buildTargetApps({ platform: 'ios', appIds: ['x'], appGroupType: 'allMicrosoftApps' })
    expect(body.apps).toHaveLength(0)
    expect(body.appGroupType).toBe('allMicrosoftApps')
  })
})

describe('readTargetedAppIds', () => {
  it('reads bundle ids (iOS) / package ids (Android) off a live apps collection', () => {
    const iosApps = [{ mobileAppIdentifier: { '@odata.type': '#microsoft.graph.iosMobileAppIdentifier', bundleId: 'b1' } }]
    expect(readTargetedAppIds('ios', iosApps)).toEqual(['b1'])
    const androidApps = [{ mobileAppIdentifier: { packageId: 'p1' } }]
    expect(readTargetedAppIds('android', androidApps)).toEqual(['p1'])
  })

  it('tolerates an empty/undefined apps collection', () => {
    expect(readTargetedAppIds('ios', undefined)).toHaveLength(0)
  })
})
