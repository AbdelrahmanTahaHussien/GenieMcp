import { Link } from 'react-router-dom'
import Container from '../components/UI/Container'
import Card from '../components/UI/Card'
import { categories } from '../data/categories'
import { products } from '../data/products'

export default function CategoriesPage() {
  return (
    <Container className="py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Categories</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Explore the catalog by what you're shopping for.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((c) => {
          const count = products.filter((p) => p.category === c.slug).length
          return (
            <Link key={c.slug} to={`/category/${c.slug}`}>
              <Card className="flex items-center gap-4 p-5">
                <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-100 text-3xl dark:bg-brand-500/15">
                  {c.emoji}
                </span>
                <div className="flex flex-1 flex-col">
                  <span className="text-base font-semibold text-slate-900 dark:text-white">{c.name}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">{c.blurb}</span>
                  <span className="mt-1 text-xs font-medium text-brand-600 dark:text-brand-300">
                    {count} product{count === 1 ? '' : 's'}
                  </span>
                </div>
                <span aria-hidden="true" className="text-slate-400">→</span>
              </Card>
            </Link>
          )
        })}
      </div>
    </Container>
  )
}
