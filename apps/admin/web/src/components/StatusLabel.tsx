import { HStack } from '@astryxdesign/core/Stack'
import { StatusDot, type StatusDotVariant } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'

interface StatusLabelProps {
  variant: StatusDotVariant
  label: string
  isPulsing?: boolean
}

/** A status as a dot plus its name, so it never rests on color alone. */
export function StatusLabel({ variant, label, isPulsing }: StatusLabelProps) {
  return (
    <HStack gap={2} vAlign="center">
      <StatusDot variant={variant} label={label} isPulsing={isPulsing} />
      <Text type="body" maxLines={1}>
        {label}
      </Text>
    </HStack>
  )
}
