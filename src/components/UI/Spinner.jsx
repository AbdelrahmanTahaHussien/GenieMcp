export default function Spinner({ size = 24, label = 'Loading' }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-block animate-spin rounded-full border-2 border-slate-300 border-t-brand-500"
      style={{ width: size, height: size }}
    />
  )
}
