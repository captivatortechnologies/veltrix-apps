import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/netskopeContracts'

registerHealthCheckContract({
  label: 'url-lists',
  handler: healthCheck,
  probePath: '/policy/urllist',
  checkName: 'netskope-urllist',
})
