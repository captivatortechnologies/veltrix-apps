import { DEPLOYMENTS_POLICIES_PATH, deploymentHealthCheck } from '../../lib/deployments'

/** Health = Umbrella authenticates and answers the policies collection. */
export default deploymentHealthCheck(DEPLOYMENTS_POLICIES_PATH, 'umbrella-policies')
