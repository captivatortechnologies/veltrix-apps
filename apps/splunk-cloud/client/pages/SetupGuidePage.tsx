import React from 'react'
import { Badge, Button, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const COMPONENT_TYPE = 'splunk-cloud-stack'
const ACS_DOCS_URL =
  'https://docs.splunk.com/Documentation/SplunkCloud/latest/Config/ACSIntro'

/**
 * Step-by-step guide for connecting a Splunk Cloud stack via the Admin Config
 * Service (ACS) API, rendered with the platform design-system components from
 * @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge / Button the
 * built-in platform screens use, themed to the app's Splunk brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'component',
      label: '1. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register your stack as a component of type{' '}
              <Badge variant="primary" size="sm">
                {COMPONENT_TYPE}
              </Badge>
              . Set its hostname to your stack name — either the bare name (<code>mystack</code>) or
              the full domain (<code>mystack.splunkcloud.com</code>); the app derives the ACS stack
              name automatically. Your stack name is the subdomain you use to reach Splunk Web.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'token',
      label: '2. ACS token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Create an ACS authentication token and store it as a Veltrix credential:</p>
            <ol>
              <li>
                Sign in to Splunk Web as a user with the <code>sc_admin</code> role.
              </li>
              <li>
                Go to <strong>Settings &gt; Tokens</strong> and create a new authentication token
                (JWT).
              </li>
              <li>
                Store the token in a Veltrix credential&apos;s <strong>API token</strong> field and
                assign that credential to your stack component.
              </li>
            </ol>
            <p>
              Tokens expire — rotate them before expiry or health checks will start failing with
              authentication errors. For automated rotation, ACS itself exposes a{' '}
              <code>/adminconfig/v2/tokens</code> endpoint.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'settings',
      label: '3. App settings',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              The default ACS base URL is <code>https://admin.splunk.com</code>. FedRAMP Moderate
              (IL2) stacks must use <code>https://admin.splunkcloudgc.com</code> instead. Set your
              Splunk Cloud Experience (Victoria or Classic) to match your stack — all configuration
              types in this app work on both.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <Badge variant="secondary" size="sm">
                Victoria
              </Badge>
              <Badge variant="secondary" size="sm">
                Classic
              </Badge>
            </div>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'deploy',
      label: '4. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create a configuration in the Configuration Canvas (indexes, HEC tokens, or IP allow
              lists) and run it through the pipeline. Validation, health checks, drift detection,
              and rollback are handled per configuration type. Deployments are asynchronous on the
              Splunk side — new indexes and HEC tokens can take a few minutes to finish
              provisioning.
            </p>
            <p>
              <small>
                Note: the ACS API is rate limited to 600 requests per 10 minutes per stack. Very
                large canvases may approach this limit during deployment.
              </small>
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(ACS_DOCS_URL, '_blank', 'noopener')}
            >
              ACS API reference
            </Button>
          </CardBody>
        </Card>
      ),
    },
  ]

  return (
    <div>
      <h2>Splunk Cloud Platform — Setup Guide</h2>
      <Tabs tabs={tabs} />
    </div>
  )
}
