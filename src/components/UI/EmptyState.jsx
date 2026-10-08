export default function EmptyState({ icon = '✨', title, message, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 px-6 py-16 text-center dark:border-slate-700">
      <div className="text-4xl" aria-hidden="true">
        {icon}
      </div>
      {title && <h3 className="text-lg font-semibold">{title}</h3>}
      {message && <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
