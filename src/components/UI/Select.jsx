export default function Select({ label, id, options = [], className = '', ...rest }) {
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
      <select id={id} className="input-base" {...rest}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}
