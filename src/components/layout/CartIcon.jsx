import { Link } from 'react-router-dom'
import { useCart } from '../../hooks/useCart'

export default function CartIcon() {
  const { count } = useCart()
  return (
    <Link
      to="/cart"
      className="relative inline-flex items-center rounded-full p-2 text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l2.4 12.5a2 2 0 0 0 2 1.6h8.3a2 2 0 0 0 2-1.5L21 8H6" />
        <circle cx="10" cy="20" r="1.4" fill="currentColor" />
        <circle cx="17" cy="20" r="1.4" fill="currentColor" />
      </svg>
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1 text-[11px] font-semibold text-white">
          {count}
        </span>
      )}
    </Link>
  )
}
