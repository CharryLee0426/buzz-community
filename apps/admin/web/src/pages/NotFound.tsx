import { useLocation } from 'react-router'
import { Button } from '@astryxdesign/core/Button'
import { Center } from '@astryxdesign/core/Center'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { useDocumentTitle } from '../lib/hooks'

export default function NotFoundPage() {
  const { pathname } = useLocation()
  useDocumentTitle('Page not found')
  return (
    <Center axis="both" height="100%" padding={6}>
      <EmptyState
        headingLevel={1}
        title="No page at this address"
        description={`Nothing in the console lives at ${pathname}.`}
        actions={<Button label="Go to Overview" href="/" variant="primary" />}
      />
    </Center>
  )
}
