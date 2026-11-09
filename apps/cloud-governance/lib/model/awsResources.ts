import type { ActionClass, Provider } from './types'
import { hasOwn } from './issues'
import {
  AZURE_PROVIDER_PREFIX,
  AZURE_RESOURCE_ID_KEY,
  AZURE_REVERSIBLE_ACTIONS,
  isAllowedAzureResource,
  normalizeAzureResource,
} from './azureResources'

export const AWS_RESOURCES = [
  'ec2',
  'ebs',
  'ebs-snapshot',
  'ami',
  'eip',
  'security-group',
  'vpc',
  'subnet',
  'elb',
  'app-elb',
  'rds',
  'rds-snapshot',
  'rds-cluster',
  's3',
  'iam-user',
  'iam-role',
  'iam-group',
  'iam-policy',
  'lambda',
  'log-group',
  'dynamodb-table',
  'sqs',
  'sns',
  'kms-key',
  'cloudtrail',
  'ecr',
  'ecs',
  'eks',
  'efs',
  'elasticache',
  'redshift',
  'cfn',
  'asg',
  'launch-template',
  'nat-gateway',
  'internet-gateway',
  'route-table',
  'network-acl',
  'secrets-manager',
  'ssm-parameter',
] as const

export type AwsResource = (typeof AWS_RESOURCES)[number]

const RESOURCE_SET: ReadonlySet<string> = new Set(AWS_RESOURCES)

export const PROVIDER_PREFIX = 'aws.'

/** The c7n resource prefix for a provider (`aws.` / `azure.`). */
export function providerPrefix(provider: Provider): string {
  return provider === 'azure' ? AZURE_PROVIDER_PREFIX : PROVIDER_PREFIX
}

export function normalizeResource(resource: string, provider: Provider = 'aws'): string {
  if (provider === 'azure') return normalizeAzureResource(resource)
  const trimmed = resource.trim()
  return trimmed.startsWith(PROVIDER_PREFIX) ? trimmed.slice(PROVIDER_PREFIX.length) : trimmed
}

export function isAllowedResource(resource: string, provider: Provider = 'aws'): boolean {
  if (provider === 'azure') return isAllowedAzureResource(resource)
  return RESOURCE_SET.has(normalizeResource(resource))
}

export const DEFAULT_RESOURCE_ID_KEY = 'id'

export const RESOURCE_ID_KEYS: Readonly<Record<AwsResource, string>> = {
  ec2: 'InstanceId',
  ebs: 'VolumeId',
  'ebs-snapshot': 'SnapshotId',
  ami: 'ImageId',
  eip: 'AllocationId',
  'security-group': 'GroupId',
  vpc: 'VpcId',
  subnet: 'SubnetId',
  elb: 'LoadBalancerName',
  'app-elb': 'LoadBalancerArn',
  rds: 'DBInstanceIdentifier',
  'rds-snapshot': 'DBSnapshotIdentifier',
  'rds-cluster': 'DBClusterIdentifier',
  s3: 'Name',
  'iam-user': 'UserName',
  'iam-role': 'RoleName',
  'iam-group': 'GroupName',
  'iam-policy': 'Arn',
  lambda: 'FunctionName',
  'log-group': 'logGroupName',
  'dynamodb-table': 'TableName',
  sqs: 'QueueUrl',
  sns: 'TopicArn',
  'kms-key': 'KeyId',
  cloudtrail: 'Name',
  ecr: 'repositoryName',
  ecs: 'clusterArn',
  eks: 'name',
  efs: 'FileSystemId',
  elasticache: 'CacheClusterId',
  redshift: 'ClusterIdentifier',
  cfn: 'StackName',
  asg: 'AutoScalingGroupName',
  'launch-template': 'LaunchTemplateId',
  'nat-gateway': 'NatGatewayId',
  'internet-gateway': 'InternetGatewayId',
  'route-table': 'RouteTableId',
  'network-acl': 'NetworkAclId',
  'secrets-manager': 'Name',
  'ssm-parameter': 'Name',
}

export function resourceIdKey(resource: string, provider: Provider = 'aws'): string {
  if (provider === 'azure') return AZURE_RESOURCE_ID_KEY
  const key = normalizeResource(resource)
  return RESOURCE_SET.has(key) ? RESOURCE_ID_KEYS[key as AwsResource] : DEFAULT_RESOURCE_ID_KEY
}

export type ActionTypeClass = Exclude<ActionClass, 'none' | 'snapshot-delete'>

export const REVERSIBLE_ACTIONS: readonly string[] = [
  'tag',
  'untag',
  'mark',
  'mark-for-op',
  'unmark',
  'remove-tag',
  'rename-tag',
  'normalize-tag',
  'tag-trim',
  'auto-tag-user',
  'copy-related-tag',
  'stop',
  'start',
  'snapshot',
  'modify-security-groups',
  'remove-permissions',
  'detach',
  'disassociate',
  'set-retention',
  'set-encryption',
  'post-finding',
  'put-metric',
  ...AZURE_REVERSIBLE_ACTIONS,
]

export const IRREVERSIBLE_ACTIONS: readonly string[] = [
  'delete',
  'terminate',
  'remove',
  'schedule-key-deletion',
  'disable-key',
  'release',
  'deregister',
  'revoke',
]

export const ACTION_CLASS: Readonly<Record<string, ActionTypeClass>> = Object.freeze({
  ...Object.fromEntries(REVERSIBLE_ACTIONS.map((type) => [type, 'reversible' as const])),
  ...Object.fromEntries(IRREVERSIBLE_ACTIONS.map((type) => [type, 'irreversible' as const])),
})

const SET_PREFIX = 'set-'
const DELETE_PREFIX = 'delete-'

export function classifyActionType(type: string): ActionTypeClass | null {
  if (hasOwn(ACTION_CLASS, type)) return ACTION_CLASS[type]
  if (type.startsWith(SET_PREFIX) && type.length > SET_PREFIX.length) return 'reversible'
  if (type.startsWith(DELETE_PREFIX) && type.length > DELETE_PREFIX.length) return 'irreversible'
  return null
}

export function isDeleteFamily(type: string): boolean {
  return type === 'delete' || type === 'terminate' || (type.startsWith(DELETE_PREFIX) && type.length > DELETE_PREFIX.length)
}
