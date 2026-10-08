export default function Price({ value, className = '' }) {
  return (
    <span className={`font-semibold text-slate-900 dark:text-white ${className}`}>
      ${value.toFixed(2)}
    </span>
  )
}
