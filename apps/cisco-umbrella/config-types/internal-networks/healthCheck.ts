import { DEPLOYMENTS_NETWORKS_PATH, deploymentHealthCheck } from '../../lib/deployments'

/** Health = Umbrella authenticates and answers the networks collection. */
export default deploymentHealthCheck(DEPLOYMENTS_NETWORKS_PATH, 'umbrella-networks')
