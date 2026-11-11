import { useEffect, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { useAnnounce } from '@astryxdesign/core/hooks'
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout'
import { errorMessage } from '../lib/errors'

// A native form keeps Enter-to-submit; `contents` keeps it out of the layout.
const formStyle: CSSProperties = { display: 'contents' }

interface FormDialogProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  children: ReactNode
  /** Omit to render a dialog that only closes, such as one showing a result. */
  submitLabel?: string
  onSubmit?: () => void
  isSubmitting?: boolean
  isSubmitDisabled?: boolean
  /** The failure from the last submit, shown above the fields. */
  error?: unknown
  cancelLabel?: string
  width?: number
}

/** The console's one dialog shape: a title, the fields, and the actions pinned to the foot. */
export function FormDialog({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  submitLabel,
  onSubmit,
  isSubmitting = false,
  isSubmitDisabled = false,
  error,
  cancelLabel,
  width = 480,
}: FormDialogProps) {
  const announce = useAnnounce()
  const failure = error ? errorMessage(error) : null
  useEffect(() => {
    if (failure) announce(`That did not go through. ${failure}`, 'assertive')
  }, [failure, announce])

  // While a submit is in flight the dialog stays, so its outcome has somewhere to land.
  const close = () => {
    if (!isSubmitting) onClose()
  }
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!onSubmit || isSubmitting || isSubmitDisabled) return
    onSubmit()
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => !open && close()}
      purpose={isSubmitting ? 'required' : submitLabel ? 'form' : 'info'}
      width={width}>
      <form onSubmit={handleSubmit} style={formStyle} noValidate>
        <Layout
          header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={close} />}
          content={
            <LayoutContent>
              <VStack gap={4}>
                {failure ? <Banner status="error" title="That did not go through" description={failure} /> : null}
                {children}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button label={cancelLabel ?? (submitLabel ? 'Cancel' : 'Done')} variant="secondary" isDisabled={isSubmitting} onClick={close} />
                {submitLabel ? (
                  <Button label={submitLabel} type="submit" variant="primary" isLoading={isSubmitting} isDisabled={isSubmitDisabled} />
                ) : null}
              </HStack>
            </LayoutFooter>
          }
        />
      </form>
    </Dialog>
  )
}
