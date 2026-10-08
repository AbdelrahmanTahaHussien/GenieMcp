import Container from '../components/UI/Container'
import FiltersPanel from '../components/filters/FiltersPanel'
import ProductGrid from '../components/product/ProductGrid'
import { products } from '../data/products'
import { useProductFilters } from '../hooks/useProductFilters'

export default function ProductsPage({ initialCategory = '', lockCategory = false, title = 'All products', subtitle }) {
  const { filters, setFilter, reset, filtered } = useProductFilters(products, {
    category: initialCategory,
  })

  return (
    <Container className="py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </header>
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside>
          <FiltersPanel
            filters={filters}
            setFilter={setFilter}
            onReset={reset}
            lockCategory={lockCategory}
            resultCount={filtered.length}
          />
        </aside>
        <ProductGrid products={filtered} />
      </div>
    </Container>
  )
}
