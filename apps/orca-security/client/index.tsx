import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'orca-security',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/orca-security/overview', label: 'Overview', icon: 'cloud' },
    { path: '/apps/orca-security/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/orca-security/connections', label: 'Connections', icon: 'link' },
  ],
}
