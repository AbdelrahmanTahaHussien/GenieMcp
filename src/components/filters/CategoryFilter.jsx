import { categories } from '../../data/categories'

export default function CategoryFilter({ value, onChange, disabled = false }) {
  const items = [{ slug: '', name: 'All' }, ...categories]
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Category
      </span>
      <div className="flex flex-wrap gap-2">
        {items.map((c) => {
          const active = value === c.slug
          return (
            <button
              key={c.slug || 'all'}
              type="button"
              disabled={disabled}
              onClick={() => onChange(c.slug)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
                active
                  ? 'border-brand-500 bg-brand-500 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-brand-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
              }`}
            >
              {c.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
