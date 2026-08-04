import { DEPLOYMENTS_INTERNAL_NETWORK_SUBNETS_PATH, deploymentHealthCheck } from '../../lib/deployments'

/** Health = Umbrella authenticates and answers the internal networks collection. */
export default deploymentHealthCheck(DEPLOYMENTS_INTERNAL_NETWORK_SUBNETS_PATH, 'umbrella-internal-network-subnets')
