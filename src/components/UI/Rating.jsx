export default function Rating({ value = 0, max = 5, showValue = true }) {
  const rounded = Math.round(value * 2) / 2
  return (
    <div className="inline-flex items-center gap-1 text-sm text-amber-500" aria-label={`${value} out of ${max}`}>
      <span aria-hidden="true">
        {Array.from({ length: max }).map((_, i) => {
          const filled = i + 1 <= Math.floor(rounded)
          const half = !filled && i + 0.5 === rounded
          return <span key={i}>{filled ? '★' : half ? '⯨' : '☆'}</span>
        })}
      </span>
      {showValue && <span className="text-slate-500 dark:text-slate-400">{value.toFixed(1)}</span>}
    </div>
  )
}
