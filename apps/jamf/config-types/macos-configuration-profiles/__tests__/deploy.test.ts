import { buildProfileCreateXml, mergeProfileXml } from '../deploy'
import { extractProfileSpecs, parseProfileGeneralXml } from '../validate'
import { extractElement } from '../../../lib/jamfClassicXml'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function specFrom(fields: Record<string, unknown>) {
  const canvas: PipelineContext['canvas'] = {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'jamf',
    entityType: 'macos-configuration-profiles',
    items: [{ name: 'sec', fields }],
    sections: [{ name: 'sec', fields }],
    snapshot: {},
  }
  return extractProfileSpecs(canvas)[0]
}

const groupByName = new Map([['fleet a', { id: '10', name: 'Fleet A' }]])
const PLIST = '<?xml version="1.0"?><plist version="1.0"><dict><key>PayloadType</key><string>Configuration</string></dict></plist>'

function expectThrows(fn: () => void, pattern: RegExp): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeTruthy()
  expect(thrown instanceof Error ? thrown.message : String(thrown)).toMatch(pattern)
}

describe('Jamf macOS Configuration Profiles deploy — XML builders', () => {
  it('buildProfileCreateXml renders general/scope with resolved group ids', () => {
    const spec = specFrom({ name: 'WiFi Profile', payloads: PLIST, computer_group_names: ['Fleet A'] })
    const xml = buildProfileCreateXml(spec, groupByName)
    expect(xml).toContain('<name>WiFi Profile</name>')
    expect(xml).toContain('<distribution_method>Install Automatically</distribution_method>')
    expect(xml).toContain('<computer_group><id>10</id><name>Fleet A</name></computer_group>')
  })

  it('the plist payload round-trips through XML-escaping without corrupting the outer document', () => {
    const spec = specFrom({ name: 'WiFi Profile', payloads: PLIST })
    const xml = buildProfileCreateXml(spec, groupByName)
    // The outer document must still be well-formed: exactly one <general> and
    // one <scope> block, both closed — i.e. the plist's own < / > characters
    // did not leak out of the escaped <payloads> text and split the document.
    const general = extractElement(xml, 'general')
    const scope = extractElement(xml, 'scope')
    expect(general).toBeTruthy()
    expect(scope).toBeTruthy()
    const parsedGeneral = parseProfileGeneralXml(general as string)
    expect(parsedGeneral.payloads).toBe(PLIST)
  })

  it('buildProfileCreateXml throws a clear error when a referenced computer group is missing', () => {
    const spec = specFrom({ name: 'X', payloads: PLIST, computer_group_names: ['Ghost Group'] })
    expectThrows(() => buildProfileCreateXml(spec, groupByName), /computer group "Ghost Group" was not found/)
  })

  it('mergeProfileXml preserves unmanaged sections (self_service, category, uuid) untouched', () => {
    const priorXml =
      '<os_x_configuration_profile>' +
      '<general><id>55</id><name>Old</name><description>Old desc</description>' +
      '<distribution_method>Install Automatically</distribution_method><user_removable>true</user_removable>' +
      '<level>computer</level><payloads>OLD_PAYLOAD</payloads>' +
      '<uuid>88F8C1DB-D92A-4D10-95FB-CE7EDE82B93E</uuid>' +
      '<category><id>3</id><name>Security</name></category></general>' +
      '<scope><all_computers>true</all_computers><computer_groups/><exclusions><computer_groups/></exclusions></scope>' +
      '<self_service><install_button_text>Install</install_button_text></self_service>' +
      '</os_x_configuration_profile>'

    const spec = specFrom({ name: 'WiFi Profile', payloads: PLIST, computer_group_names: ['Fleet A'] })
    const merged = mergeProfileXml(priorXml, spec, groupByName)

    expect(merged).toContain('<name>WiFi Profile</name>')
    expect(merged).toContain('<computer_group><id>10</id><name>Fleet A</name></computer_group>')
    const mergedGeneral = extractElement(merged, 'general') as string
    expect(parseProfileGeneralXml(mergedGeneral).payloads).toBe(PLIST)
    // Unmanaged fields preserved.
    expect(merged).toContain('<uuid>88F8C1DB-D92A-4D10-95FB-CE7EDE82B93E</uuid>')
    expect(merged).toContain('<category><id>3</id><name>Security</name></category>')
    expect(merged).toContain('<self_service><install_button_text>Install</install_button_text></self_service>')
  })
})
