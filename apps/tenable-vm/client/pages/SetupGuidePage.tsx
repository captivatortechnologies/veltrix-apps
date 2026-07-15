import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Scheduled scans', 'Asset tags', 'Exclusions']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-keys',
      label: '1. API keys',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Tenable Vulnerability Management, go to{' '}
              <strong>Settings &gt; My Account &gt; API Keys</strong> and generate a key pair. Tenable
              shows the <strong>access key</strong> and <strong>secret key</strong> once — copy both.
            </p>
            <p>
              The account you generate keys for needs permission to manage what this app configures:
            </p>
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
            <p>
              Store the key pair as a Veltrix credential:
            </p>
            <ul>
              <li>
                <strong>Username</strong> → the Tenable <em>access key</em>
              </li>
              <li>
                <strong>API token</strong> → the Tenable <em>secret key</em>
              </li>
            </ul>
            <p>
              The app authenticates every request with{' '}
              <code>X-ApiKeys: accessKey=…; secretKey=…</code> — there is no login step.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>tenable-vm-tenant</strong> component and attach the credential. Leave
              the hostname blank to use the global endpoint (<code>cloud.tenable.com</code>); set it
              only for a dedicated or FedRAMP host.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline — validate, deploy, health check, drift detection and rollback are handled per
              configuration type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
