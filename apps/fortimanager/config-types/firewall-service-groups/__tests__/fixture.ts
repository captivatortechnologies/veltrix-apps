import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-service-groups',
  objectPath: '/obj/firewall/service/group',
  checkName: 'fmg-firewall-service-group',
  name: 'web-services',
  item: {
    id: 'item-1',
    name: 'web-services',
    fields: { name: 'web-services', members: 'HTTP, HTTPS', comment: 'Web service set' },
  },
  body: { name: 'web-services', member: ['HTTP', 'HTTPS'], comment: 'Web service set' },
  livePrior: { name: 'web-services', member: [{ name: 'HTTP' }], comment: 'Web service set' },
  priorSnapshot: { name: 'web-services', member: ['HTTP'], comment: 'Web service set' },
  liveInSync: { name: 'web-services', member: ['HTTP', 'HTTPS'], comment: 'Web service set' },
  driftField: 'web-services.member',
  deploySuccess: 'Deployed 1 firewall service group(s)',
  deployFailurePrefix: 'Some service groups failed',
  rollbackPrefix: 'Rolled back firewall service groups',
}
