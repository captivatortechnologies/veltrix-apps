import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Security Zones',
  'Network Objects',
  'Network Groups',
  'Port Objects',
  'Port Groups',
  'URL Objects',
  'URL Groups',
  'Access Control Policies',
  'Access Rules',
]

const DEPLOY_ORDER = ['Security Zones + Network/Port/URL Objects', 'Network/Port/URL Groups', 'Access Control Policies', 'Access Rules']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'user',
      label: '1. FMC user',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Create a dedicated FMC user for this app with a role scoped to what it manages:</p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              An <strong>Access Admin</strong> or <strong>Network Admin</strong> role covers the objects and
              policies this app writes. This app authenticates the same way the FMC web UI's login form
              does - a plain username and password, no API key.
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
            <p>Store the FMC user's credentials as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> - the FMC username
              </li>
              <li>
                <strong>Password</strong> - that user's password
              </li>
            </ul>
            <p>
              On first use the app logs in via <code>POST /api/fmc_platform/v1/auth/generatetoken</code> (the
              same call the FMC web UI's own login makes) and re-logs-in automatically if the session
              expires.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & deploy order',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register an <strong>fmc</strong> component whose hostname is your FMC management address (e.g.{' '}
              <code>fmc.example.com</code>), attach the credential. If you manage more than one FMC domain,
              set the <strong>Domain Name</strong> app setting explicitly - otherwise the app uses the
              connecting user's own login domain.
            </p>
            <p>
              Author configurations in the Configuration Canvas and deploy them through the pipeline in
              this order, since later types reference objects the earlier ones create:
            </p>
            <ol>
              {DEPLOY_ORDER.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'deploy-to-devices',
      label: '4. Deploy to devices',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Writing configuration through this app only edits FMC's own configuration database. Pushing
              that configuration onto managed firewalls is a <strong>separate, one-shot activation step</strong>{' '}
              (the FMC analogue of a Panorama commit-and-push) - it is never modeled as a configuration
              type here, since it has no stable "current state" to declare or drift-check.
            </p>
            <p>
              Enable the <strong>Auto-deploy to devices</strong> app setting to have every successful
              deploy/rollback automatically trigger a deployment to devices with pending changes. Leave it
              off (the default) to deploy to devices yourself from the FMC UI once you are ready to
              activate a batch of changes.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
