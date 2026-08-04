import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Security Monitoring Rules',
  'Security Monitoring Suppressions',
  'Security Filters',
  'Sensitive Data Scanner',
  'Log Pipelines',
  'Log Archives',
  'Log-Based Metrics',
  'Log Indexes',
  'Monitors',
  'SLOs',
  'Roles',
]

const PERMISSIONS = [
  'security_monitoring_rules_read',
  'security_monitoring_rules_write',
  'security_monitoring_suppressions_read',
  'security_monitoring_suppressions_write',
  'security_monitoring_filters_write',
  'monitors_write',
  'logs_write_pipelines',
  'logs_modify_indexes',
  'data_scanner_write',
  'user_access_read',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'keys',
      label: '1. API + Application keys',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Datadog, go to <strong>Organization Settings &gt; API Keys</strong> and create (or reuse) an{' '}
              <strong>API key</strong>. Then go to <strong>Organization Settings &gt; Application Keys</strong>{' '}
              and create an <strong>Application key</strong> owned by a user with these permissions:
            </p>
            <div>
              {PERMISSIONS.map((perm) => (
                <Badge key={perm} variant="primary" size="sm">
                  {perm}
                </Badge>
              ))}
            </div>
            <p>
              This app manages: {MANAGES.join(', ')}. Both the API key and the Application key are required for
              every operation, including reads, on Security Monitoring Rules/Suppressions/Filters. The
              permissions above are the ones this app's research directly confirmed against Datadog's docs —
              also grant standard read/write access for Log Archives, Log-Based Metrics, SLOs and Roles, or
              simply use the built-in Datadog Admin role.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the two keys as a Veltrix credential (on the Connections page):</p>
            <ul>
              <li>
                <strong>API Key</strong> → the Datadog API key
              </li>
              <li>
                <strong>Application Key</strong> → the Datadog Application key
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Site',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On the Connections page, set the connection's <strong>Endpoint</strong> to your organization's{' '}
              <strong>Datadog site</strong> — not a URL. Find yours from the Datadog app's user menu ("Region:
              ..."), or use one of:
            </p>
            <ul>
              <li>
                <code>datadoghq.com</code> — US1 (default)
              </li>
              <li>
                <code>us3.datadoghq.com</code> — US3
              </li>
              <li>
                <code>us5.datadoghq.com</code> — US5
              </li>
              <li>
                <code>datadoghq.eu</code> — EU1
              </li>
              <li>
                <code>ap1.datadoghq.com</code> — AP1
              </li>
              <li>
                <code>ap2.datadoghq.com</code> — AP2
              </li>
              <li>
                <code>ddog-gov.com</code> — US1-FED
              </li>
            </ul>
            <p>
              Saving the connection registers a <strong>datadog-org</strong> component (hostname = the site) and
              attaches the credential, so Deploy is enabled.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
