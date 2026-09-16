import type { ConfigFixture } from '../../../lib/__tests__/configFixture'

export const fixture: ConfigFixture = {
  id: 'firewall-internet-service-custom-groups',
  objectPath: '/obj/firewall/internet-service-custom-group',
  checkName: 'fmg-firewall-internet-service-custom-group',
  name: 'partner-services',
  item: {
    id: 'item-1',
    name: 'partner-services',
    fields: { name: 'partner-services', members: 'partner-saas, partner-api', comment: 'Partner service set' },
  },
  body: { name: 'partner-services', member: ['partner-saas', 'partner-api'], comment: 'Partner service set' },
  livePrior: { name: 'partner-services', member: [{ name: 'partner-saas' }], comment: 'Partner service set' },
  priorSnapshot: { name: 'partner-services', member: ['partner-saas'], comment: 'Partner service set' },
  liveInSync: { name: 'partner-services', member: ['partner-saas', 'partner-api'], comment: 'Partner service set' },
  driftField: 'partner-services.member',
  deploySuccess: 'Deployed 1 custom internet service group(s)',
  deployFailurePrefix: 'Some internet service groups failed',
  rollbackPrefix: 'Rolled back custom internet service groups',
}
