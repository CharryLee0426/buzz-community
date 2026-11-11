import { Button } from '@astryxdesign/core/Button'
import { useState } from 'react'
import { useClipboard } from '@astryxdesign/core/hooks'
import { HStack, StackItem } from '@astryxdesign/core/Stack'
import { TextInput } from '@astryxdesign/core/TextInput'

interface CopyFieldProps {
  label: string
  value: string
  description?: string
  /** Button text; defaults to "Copy". */
  copyLabel?: string
}

/** A read-only value with a button that copies it and says so. */
export function CopyField({ label, value, description, copyLabel = 'Copy' }: CopyFieldProps) {
  const { copy, isCopied } = useClipboard({ announce: `${label} copied`, resetAfterMs: 2500 })
  const [hasFailed, setHasFailed] = useState(false)

  return (
    <HStack gap={2} vAlign="end">
      <StackItem size="fill">
        <TextInput label={label} description={description} value={value} isReadOnly width="100%" />
      </StackItem>
      <Button
        label={isCopied ? 'Copied' : copyLabel}
        variant="secondary"
        tooltip={hasFailed ? 'The browser blocked copying. Select the text and copy it by hand.' : undefined}
        onClick={() => void copy(value).then((copied) => setHasFailed(!copied))}
      />
    </HStack>
  )
}
