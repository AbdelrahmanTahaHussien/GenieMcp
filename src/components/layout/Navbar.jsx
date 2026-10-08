import { NavLink, Link } from 'react-router-dom'
import Container from '../UI/Container'
import CartIcon from './CartIcon'

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/products', label: 'Products' },
  { to: '/categories', label: 'Categories' },
]

const linkClass = ({ isActive }) =>
  `text-sm font-medium transition ${
    isActive
      ? 'text-brand-600 dark:text-brand-300'
      : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
  }`

export default function Navbar() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 backdrop-blur-md dark:border-slate-800/70 dark:bg-slate-950/70">
      <Container className="flex h-16 items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-soft">
            <span className="text-base font-bold">C</span>
          </span>
          <span className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            celfronteders
          </span>
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <CartIcon />
        </div>
      </Container>
      <nav className="flex items-center justify-center gap-5 border-t border-slate-100 py-2 text-sm md:hidden dark:border-slate-900">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}
