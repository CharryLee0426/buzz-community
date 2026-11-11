import { VStack } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { shortKey } from '../lib/format'

interface IdentityProps {
  /** Display name from the identity's profile, when it has published one. */
  name: string | null | undefined
  npub: string
  /** Shown in place of a name the identity never set. */
  fallback?: string
}

/**
 * A Nostr identity as a person reads it: the name it gave itself over the key
 * that actually identifies it. The key is always shown, because names repeat
 * and anyone can pick one.
 */
export function Identity({ name, npub, fallback = 'No name set' }: IdentityProps) {
  return (
    <VStack gap={0}>
      <Text type="body" weight={name ? 'medium' : 'normal'} color={name ? 'primary' : 'secondary'} maxLines={1}>
        {name || fallback}
      </Text>
      <Text type="code" size="xsm" color="secondary" maxLines={1} hasTruncateTooltip={false}>
        {shortKey(npub)}
      </Text>
    </VStack>
  )
}
