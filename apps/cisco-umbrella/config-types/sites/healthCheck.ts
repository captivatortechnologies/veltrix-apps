import { DEPLOYMENTS_SITES_PATH, deploymentHealthCheck } from '../../lib/deployments'

/** Health = Umbrella authenticates and answers the sites collection. */
export default deploymentHealthCheck(DEPLOYMENTS_SITES_PATH, 'umbrella-sites')
