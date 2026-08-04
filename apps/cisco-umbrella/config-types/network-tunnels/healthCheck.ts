import { DEPLOYMENTS_TUNNELS_PATH, deploymentHealthCheck } from '../../lib/deployments'

/** Health = Umbrella authenticates and answers the tunnels collection. */
export default deploymentHealthCheck(DEPLOYMENTS_TUNNELS_PATH, 'umbrella-tunnels')
