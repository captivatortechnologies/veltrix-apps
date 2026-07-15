import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))

export default {
  id: 'cloudflare',
  pages: { OverviewPage, SetupGuidePage },
  sidebarItems: [
    { path: '/apps/cloudflare/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cloudflare/setup', label: 'Setup Guide', icon: 'book' },
  ],
}
