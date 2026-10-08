const VARIANTS = {
  primary:
    'bg-brand-500 text-white hover:bg-brand-600 focus-visible:ring-brand-500/40 shadow-sm',
  ghost:
    'bg-transparent text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
  outline:
    'border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800',
  icon: 'p-2 rounded-full text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  danger: 'bg-rose-500 text-white hover:bg-rose-600',
}

const SIZES = {
  sm: 'text-sm px-3 py-1.5',
  md: 'text-sm px-4 py-2',
  lg: 'text-base px-5 py-2.5',
}

/**
 * Reusable button atom with variants (primary, ghost, outline, icon, danger)
 * and sizes (sm, md, lg). Used everywhere a CTA or icon-trigger is needed.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...rest
}) {
  const isIcon = variant === 'icon'
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 disabled:opacity-50 disabled:cursor-not-allowed'
  const sizeClass = isIcon ? '' : SIZES[size]
  return (
    <button
      type={type}
      className={`${base} ${VARIANTS[variant]} ${sizeClass} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
