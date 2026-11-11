import { useMemo, type CSSProperties, type ReactNode, type SVGProps } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { Center } from '@astryxdesign/core/Center'
import { Icon } from '@astryxdesign/core/Icon'
import { HStack, VStack } from '@astryxdesign/core/Stack'
import { Heading, Text } from '@astryxdesign/core/Text'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ChartRow, ChartSeries } from '../lib/chartData'
import { formatMoment, formatTick } from '../lib/format'

const AXIS_TICK = { fontSize: 'var(--font-size-sm)', fill: 'var(--color-text-secondary)' }
const GRID_STROKE = 'var(--color-border)'
const CHART_MARGIN = { top: 8, right: 12, left: 0, bottom: 0 }
const HEIGHT = 220

// Each series also gets its own stroke pattern, so two lines can be told
// apart without relying on color. The legend draws the same pattern.
const DASHES = ['', '7 3', '2 3', '9 3 2 3']
const LEGEND_KEYS = DASHES.map(
  (dash) =>
    function LegendKey(props: SVGProps<SVGSVGElement>) {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} {...props}>
          <line x1="1" y1="12" x2="23" y2="12" strokeDasharray={dash} />
        </svg>
      )
    },
)

// Straight segments between samples: smoothing would draw values nothing measured.
const LINE_PROPS = {
  type: 'linear',
  strokeLinejoin: 'miter',
  strokeLinecap: 'butt',
  dot: false,
  isAnimationActive: false,
  connectNulls: false,
} as const

/**
 * Round clock times across the window. Recharts would otherwise place ticks
 * only where samples exist, so a chart with ten minutes of data in a six-hour
 * window would show a single label.
 */
function timeTicks(start: number, end: number, windowHours: number) {
  const minutes = windowHours <= 1 ? 10 : windowHours <= 6 ? 60 : windowHours <= 24 ? 240 : 1440
  const step = minutes * 60_000
  // Align to local time, so a daily tick falls on midnight where the operator is.
  const offset = new Date(end).getTimezoneOffset() * 60_000
  const ticks: number[] = []
  for (let at = Math.ceil((start - offset) / step) * step + offset; at <= end; at += step) ticks.push(at)
  return ticks
}

function LegendEntry({ color, index, children }: { color: string; index: number; children: ReactNode }) {
  // Icon's color prop takes semantic names only; a series color is set inline.
  const style: CSSProperties = { color }
  return (
    <HStack gap={1.5} vAlign="center">
      <Icon icon={LEGEND_KEYS[index % LEGEND_KEYS.length]!} size="sm" style={style} />
      <Text type="supporting">{children}</Text>
    </HStack>
  )
}

interface TooltipEntry {
  dataKey: string
  name: string
  value: number | null
  color: string
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
  formatValue,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: number
  series: ChartSeries[]
  formatValue: (value: number) => string
}) {
  if (!active || !payload?.length || typeof label !== 'number') return null
  const rows = payload.filter((entry) => typeof entry.value === 'number').sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  if (rows.length === 0) return null
  return (
    <Card padding={3} elevation="med">
      <VStack gap={1}>
        <Text type="supporting">{formatMoment(label)}</Text>
        {rows.slice(0, 8).map((entry) => (
          <LegendEntry key={entry.dataKey} color={entry.color} index={series.findIndex((item) => item.key === entry.dataKey)}>
            {entry.name}: {formatValue(entry.value as number)}
          </LegendEntry>
        ))}
      </VStack>
    </Card>
  )
}

interface TimeChartProps {
  title: string
  /** One line on what is measured and where it comes from. */
  caption: string
  rows: ChartRow[]
  series: ChartSeries[]
  windowHours: number
  /** The moment the data was read, in epoch milliseconds: the right-hand edge of the chart. */
  asOf: number
  formatValue: (value: number) => string
  /** The values are counts of whole things, so the axis has no fractional ticks. */
  isCount?: boolean
  /** Shown instead of an empty plot when there is nothing to draw. */
  emptyText?: string
}

export function TimeChart({ title, caption, rows, series, windowHours, asOf, formatValue, isCount = false, emptyText }: TimeChartProps) {
  const hasData = rows.some((row) => series.some((entry) => typeof row[entry.key] === 'number'))
  const start = asOf - windowHours * 3_600_000
  const ticks = useMemo(() => timeTicks(start, asOf, windowHours), [start, asOf, windowHours])

  return (
    <Card padding={5}>
      <VStack gap={4}>
        <VStack gap={0.5}>
          <Heading level={3}>{title}</Heading>
          <Text type="supporting">{caption}</Text>
        </VStack>
        {hasData ? (
          <>
            <ResponsiveContainer width="100%" height={HEIGHT}>
              <LineChart data={rows} margin={CHART_MARGIN} title={title} desc={caption}>
                <CartesianGrid horizontal vertical={false} stroke={GRID_STROKE} />
                <XAxis
                  dataKey="at"
                  type="number"
                  scale="time"
                  domain={[start, asOf]}
                  ticks={ticks}
                  tickFormatter={(value: number) => formatTick(value, windowHours)}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={24}
                />
                <YAxis
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                  tickFormatter={(value: number) => formatValue(value)}
                  allowDecimals={!isCount}
                />
                <Tooltip content={<ChartTooltip series={series} formatValue={formatValue} />} cursor={{ stroke: GRID_STROKE }} />
                {series.map((entry, index) => (
                  <Line
                    {...LINE_PROPS}
                    key={entry.key}
                    dataKey={entry.key}
                    name={entry.name}
                    stroke={entry.color}
                    strokeWidth={1.5}
                    strokeDasharray={DASHES[index % DASHES.length]}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            {series.length > 1 ? (
              <HStack gap={4} vAlign="center" wrap="wrap">
                {series.map((entry, index) => (
                  <LegendEntry key={entry.key} color={entry.color} index={index}>
                    {entry.name}
                  </LegendEntry>
                ))}
              </HStack>
            ) : null}
          </>
        ) : (
          <Center axis="both" height={HEIGHT}>
            <Text type="supporting">{emptyText ?? 'No samples in this window yet.'}</Text>
          </Center>
        )}
      </VStack>
    </Card>
  )
}
