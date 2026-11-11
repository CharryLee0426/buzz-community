import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Center } from '@astryxdesign/core/Center'
import { useAnnounce } from '@astryxdesign/core/hooks'
import { Icon } from '@astryxdesign/core/Icon'
import { VStack } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { BrandMark } from '../components/BrandMark'
import { ApiError } from '../lib/api'
import { useDocumentTitle } from '../lib/hooks'
import { useSession, useSignIn } from '../lib/session'

// Standalone page: it paints its own ground because no shell wraps it.
const pageStyle: CSSProperties = { backgroundColor: 'var(--color-background-body)' }
const formStyle: CSSProperties = { display: 'contents' }

function describeFailure(error: unknown): { title: string; description: string } {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return { title: 'Sign-in failed', description: 'The username or password is wrong.' }
    }
    if (error.status === 429) {
      const wait = error.retryAfter
      return {
        title: 'Too many attempts',
        description: wait ? `Sign-in is paused for ${formatWait(wait)}.` : 'Sign-in is paused. Try again shortly.',
      }
    }
    if (error.status === 0) {
      return { title: 'Console unreachable', description: 'The request did not reach the server. Check the connection and retry.' }
    }
    return { title: 'Sign-in failed', description: error.message }
  }
  return { title: 'Sign-in failed', description: 'Something unexpected went wrong. Retry in a moment.' }
}

function formatWait(seconds: number) {
  if (seconds < 90) return `${seconds} s`
  return `${Math.ceil(seconds / 60)} min`
}

export default function LoginPage() {
  const location = useLocation()
  const session = useSession()
  const signIn = useSignIn()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  useDocumentTitle('Sign in')

  const canSubmit = username.trim() !== '' && password !== ''
  const failure = signIn.isError ? describeFailure(signIn.error) : null
  const announce = useAnnounce()
  const failureText = failure ? `${failure.title}. ${failure.description}` : null
  useEffect(() => {
    if (failureText) announce(failureText, 'assertive')
  }, [failureText, announce])

  if (session.data) {
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit || signIn.isPending) return
    signIn.mutate({ username: username.trim(), password }, { onError: () => setPassword('') })
  }

  return (
    <Center axis="both" padding={6} minHeight="100%" style={pageStyle}>
      <VStack gap={6} hAlign="center" width="100%" maxWidth={380}>
        <VStack gap={2} hAlign="center">
          <Icon icon={BrandMark} size="lg" color="accent" />
          <Text type="large" weight="semibold">
            Buzz Community
          </Text>
        </VStack>

        <Card padding={8} width="100%">
          {/* A native form keeps Enter-to-submit and password-manager autofill. */}
          <form onSubmit={handleSubmit} style={formStyle} noValidate>
            <VStack gap={5} hAlign="stretch">
              <VStack gap={1}>
                <Heading level={1}>Sign in</Heading>
                <Text type="supporting">Operator console for {window.location.host}</Text>
              </VStack>

              {failure ? <Banner status="error" title={failure.title} description={failure.description} /> : null}

              <VStack gap={4} hAlign="stretch">
                <TextInput
                  label="Username"
                  value={username}
                  onChange={setUsername}
                  size="lg"
                  htmlName="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  hasAutoCorrect={false}
                  hasSpellCheck={false}
                  hasAutoFocus
                />
                <TextInput
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  size="lg"
                  htmlName="password"
                  autoComplete="current-password"
                />
              </VStack>

              <Button
                label="Sign in"
                type="submit"
                variant="primary"
                size="lg"
                width="100%"
                isLoading={signIn.isPending}
                isDisabled={!canSubmit}
              />
            </VStack>
          </form>
        </Card>
      </VStack>
    </Center>
  )
}
