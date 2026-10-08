export default function Input({ label, id, className = '', ...rest }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {label && (
        <label
          htmlFor={id}
          className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
        >
          {label}
        </label>
      )}
      <input id={id} className="input-base" {...rest} />
    </div>
  )
}
