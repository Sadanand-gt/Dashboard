import type { LabelProps } from 'recharts'

export function SingleLineBarLabel({
  viewBox,
  value,
  fill = '#334155',
  formatter,
  offset = 5,
}: LabelProps) {
  const amount = Number(value)
  if (!viewBox || !('x' in viewBox) || !Number.isFinite(amount)) return null

  const x = Number(viewBox.x ?? 0) + Number(viewBox.width ?? 0) + Number(offset)
  const y = Number(viewBox.y ?? 0) + Number(viewBox.height ?? 0) / 2
  const label = formatter ? formatter(amount) : String(amount)

  return (
    <text
      x={x}
      y={y}
      fill={fill}
      fontSize={10}
      fontWeight={700}
      dominantBaseline="central"
      textAnchor="start"
      pointerEvents="none"
    >
      {label}
    </text>
  )
}
