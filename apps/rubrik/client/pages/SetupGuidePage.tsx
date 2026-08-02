import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['SLA Domains (backup policies)']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'service-account',
      label: '1. Service account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Rubrik cluster, go to{' '}
              <strong>Settings &gt; Users &amp; Roles &gt; Service Accounts</strong> and create a service
              account. Rubrik shows the <strong>service account id</strong> and its{' '}
              <strong>secret</strong> once — copy both.
            </p>
            <p>Grant the service account a role that can manage what this app configures:</p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
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
            <p>Store the service account as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Rubrik <em>service account id</em>
              </li>
              <li>
                <strong>API token</strong> → the Rubrik <em>secret</em>
              </li>
            </ul>
            <p>
              The app exchanges these for a session token at{' '}
              <code>POST /api/v1/service_account/session</code> and then calls the CDM API with{' '}
              <code>Authorization: Bearer &lt;token&gt;</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '3. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On the <strong>Connections</strong> page, register the Rubrik cluster: set the endpoint to
              the cluster HTTPS address (e.g. <code>https://rubrik.example.com</code>) and attach the
              service-account credential. Saving it registers a <strong>rubrik-cluster</strong> component
              the SLA Domains config type deploys to. Use the per-row test to confirm the session opens
              and the cluster answers.
            </p>
            <p>
              Rubrik clusters commonly ship a self-signed certificate — TLS verification is off by
              default and can be enforced in the app settings.
            </p>
            <p>
              Then author an SLA Domain in the Configuration Canvas and deploy it through the pipeline —
              validate, deploy, health check, drift detection and rollback are handled per configuration
              type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
