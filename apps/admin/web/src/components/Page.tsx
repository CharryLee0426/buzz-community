import type { ReactNode } from 'react'
import { HStack, Layout, LayoutContent, LayoutHeader, StackItem, VStack } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import { useDocumentTitle } from '../lib/hooks'

interface PageProps {
  title: string
  /** One line saying what the page shows, with live facts when there are any. */
  summary?: ReactNode
  /** Controls that act on the whole page: a primary action, a time range. */
  actions?: ReactNode
  /** A row under the title for tabs or filters that scope the content. */
  toolbar?: ReactNode
  /** A panel docked at the inline end. */
  panel?: ReactNode
  children: ReactNode
}

/**
 * The frame every console page shares: a pinned header carrying the page's h1
 * and actions over a content region that scrolls on its own.
 */
export function Page({ title, summary, actions, toolbar, panel, children }: PageProps) {
  useDocumentTitle(title)

  return (
    <Layout
      height="fill"
      padding={6}
      header={
        <LayoutHeader hasDivider>
          <VStack gap={4}>
            <HStack gap={4} vAlign="center" wrap="wrap">
              <StackItem size="fill">
                <VStack gap={0.5}>
                  <Heading level={1}>{title}</Heading>
                  {summary ? <Text type="supporting">{summary}</Text> : null}
                </VStack>
              </StackItem>
              {actions ? (
                <HStack gap={2} vAlign="center" wrap="wrap">
                  {actions}
                </HStack>
              ) : null}
            </HStack>
            {toolbar}
          </VStack>
        </LayoutHeader>
      }
      end={panel}
      content={<LayoutContent padding={6}>{children}</LayoutContent>}
    />
  )
}
