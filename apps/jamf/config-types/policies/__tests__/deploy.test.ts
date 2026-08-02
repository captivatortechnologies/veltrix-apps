import { buildPolicyCreateXml, mergePolicyXml } from '../deploy'
import { extractPolicySpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function specFrom(fields: Record<string, unknown>) {
  const canvas: PipelineContext['canvas'] = {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'jamf',
    entityType: 'policies',
    items: [{ name: 'sec', fields }],
    sections: [{ name: 'sec', fields }],
    snapshot: {},
  }
  return extractPolicySpecs(canvas)[0]
}

const refs = {
  groupByName: new Map([['apple silicon macs', { id: '10', name: 'Apple Silicon Macs' }]]),
  scriptByName: new Map([['install-rosetta.sh', { id: '20', name: 'install-rosetta.sh' }]]),
  packageByName: new Map([['rosetta.pkg', { id: '30', name: 'Rosetta.pkg' }]]),
}

/** The test shim has no `toThrow` matcher — assert manually. */
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

describe('Jamf Policies deploy — XML builders', () => {
  it('buildPolicyCreateXml renders general/scope/scripts/package_configuration with resolved ids', () => {
    const spec = specFrom({
      name: 'Install Rosetta',
      enabled: true,
      frequency: 'Once per computer',
      triggers: ['trigger_checkin'],
      all_computers: false,
      computer_group_names: ['Apple Silicon Macs'],
      scripts_json: JSON.stringify([{ name: 'install-rosetta.sh', priority: 'After' }]),
      packages_json: JSON.stringify([{ name: 'Rosetta.pkg', action: 'Install' }]),
    })
    const xml = buildPolicyCreateXml(spec, refs)

    expect(xml).toContain('<name>Install Rosetta</name>')
    expect(xml).toContain('<enabled>true</enabled>')
    expect(xml).toContain('<trigger_checkin>true</trigger_checkin>')
    expect(xml).toContain('<trigger_login>false</trigger_login>')
    expect(xml).toContain('<frequency>Once per computer</frequency>')
    expect(xml).toContain('<computer_group><id>10</id><name>Apple Silicon Macs</name></computer_group>')
    expect(xml).toContain('<script><id>20</id><name>install-rosetta.sh</name><priority>After</priority></script>')
    expect(xml).toContain('<package><id>30</id><name>Rosetta.pkg</name><action>Install</action></package>')
    // No unmanaged sections in a fresh create.
    expect(xml.includes('self_service')).toBeFalsy()
  })

  it('buildPolicyCreateXml throws a clear error when a referenced computer group is missing', () => {
    const spec = specFrom({ name: 'Bad Scope', computer_group_names: ['Does Not Exist'] })
    expectThrows(() => buildPolicyCreateXml(spec, refs), /computer group "Does Not Exist" was not found/)
  })

  it('buildPolicyCreateXml throws a clear error when a referenced script is missing', () => {
    const spec = specFrom({ name: 'Bad Script', scripts_json: JSON.stringify([{ name: 'ghost.sh', priority: 'After' }]) })
    expectThrows(() => buildPolicyCreateXml(spec, refs), /script "ghost.sh" was not found/)
  })

  it('buildPolicyCreateXml throws a clear error when a referenced package is missing', () => {
    const spec = specFrom({ name: 'Bad Package', packages_json: JSON.stringify([{ name: 'ghost.pkg', action: 'Install' }]) })
    expectThrows(() => buildPolicyCreateXml(spec, refs), /package "ghost.pkg" was not found/)
  })

  it('mergePolicyXml preserves unmanaged sections (self_service, category) untouched', () => {
    const priorXml =
      '<policy>' +
      '<general><id>99</id><name>Old Name</name><enabled>false</enabled>' +
      '<trigger_checkin>false</trigger_checkin><trigger_login>false</trigger_login>' +
      '<trigger_logout>false</trigger_logout><trigger_network_state_changed>false</trigger_network_state_changed>' +
      '<trigger_startup>false</trigger_startup><frequency>Once per user</frequency>' +
      '<category><id>3</id><name>Enrollment</name></category></general>' +
      '<scope><all_computers>true</all_computers><computer_groups/><exclusions><computer_groups/></exclusions></scope>' +
      '<scripts/>' +
      '<package_configuration><packages/></package_configuration>' +
      '<self_service><use_for_self_service>true</use_for_self_service><self_service_description>Do not touch</self_service_description></self_service>' +
      '<maintenance><recon>true</recon></maintenance>' +
      '</policy>'

    const spec = specFrom({
      name: 'Install Rosetta',
      enabled: true,
      frequency: 'Ongoing',
      triggers: ['trigger_checkin'],
      computer_group_names: ['Apple Silicon Macs'],
    })

    const merged = mergePolicyXml(priorXml, spec, refs)

    // Managed fields updated.
    expect(merged).toContain('<name>Install Rosetta</name>')
    expect(merged).toContain('<enabled>true</enabled>')
    expect(merged).toContain('<frequency>Ongoing</frequency>')
    expect(merged).toContain('<trigger_checkin>true</trigger_checkin>')
    expect(merged).toContain('<computer_group><id>10</id><name>Apple Silicon Macs</name></computer_group>')

    // Unmanaged sections/leaves preserved byte-for-byte.
    expect(merged).toContain('<category><id>3</id><name>Enrollment</name></category>')
    expect(merged).toContain('<self_service><use_for_self_service>true</use_for_self_service><self_service_description>Do not touch</self_service_description></self_service>')
    expect(merged).toContain('<maintenance><recon>true</recon></maintenance>')
    expect(merged).toContain('<id>99</id>')
  })

  it('mergePolicyXml still targets scope/scripts/package_configuration when the prior general block is minimal', () => {
    const priorXml = '<policy><general><id>1</id><name>X</name></general><self_service><a>1</a></self_service></policy>'
    const spec = specFrom({ name: 'Y', enabled: true, frequency: 'Ongoing' })
    const merged = mergePolicyXml(priorXml, spec, refs)
    expect(merged).toContain('<name>Y</name>')
    expect(merged).toContain('<frequency>Ongoing</frequency>')
    expect(merged).toContain('<scope>')
    expect(merged).toContain('<scripts>')
    expect(merged).toContain('<package_configuration>')
    expect(merged).toContain('<self_service><a>1</a></self_service>')
  })
})
