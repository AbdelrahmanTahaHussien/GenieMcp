import { Link } from 'react-router-dom'
import Container from '../components/UI/Container'
import Button from '../components/UI/Button'
import Badge from '../components/UI/Badge'
import ProductGrid from '../components/product/ProductGrid'
import { products } from '../data/products'
import { categories } from '../data/categories'

export default function HomePage() {
  const featured = [...products].sort((a, b) => b.rating - a.rating).slice(0, 4)

  return (
    <>
      <section className="bg-hero-gradient">
        <Container className="grid items-center gap-10 py-16 sm:py-24 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <Badge tone="brand">New season · 2026</Badge>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              Tech you'll <span className="bg-gradient-to-r from-brand-500 to-brand-700 bg-clip-text text-transparent">love</span>,
              prices you won't believe.
            </h1>
            <p className="max-w-xl text-base text-slate-600 dark:text-slate-300">
              Hand-picked audio, wearables and smart-home gear. Free shipping over $100, 30-day returns,
              no questions asked.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link to="/products">
                <Button size="lg">Shop all products</Button>
              </Link>
              <Link to="/categories">
                <Button size="lg" variant="outline">
                  Browse categories
                </Button>
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {featured.slice(0, 4).map((p, i) => (
              <Link
                key={p.id}
                to={`/products/${p.id}`}
                className={`group relative overflow-hidden rounded-2xl shadow-soft ${
                  i % 3 === 0 ? 'aspect-square' : 'aspect-square'
                }`}
              >
                <img
                  src={p.image}
                  alt={p.title}
                  className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 text-xs font-medium text-white">
                  {p.title}
                </div>
              </Link>
            ))}
          </div>
        </Container>
      </section>

      <Container className="py-12">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-semibold">Shop by category</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">Find what you're looking for, fast.</p>
          </div>
          <Link
            to="/categories"
            className="hidden text-sm font-medium text-brand-600 hover:underline sm:block dark:text-brand-300"
          >
            View all →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {categories.map((c) => (
            <Link
              key={c.slug}
              to={`/category/${c.slug}`}
              className="card-surface flex flex-col items-center gap-2 p-5 text-center"
            >
              <span className="text-3xl">{c.emoji}</span>
              <span className="text-sm font-semibold text-slate-900 dark:text-white">{c.name}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">{c.blurb}</span>
            </Link>
          ))}
        </div>
      </Container>

      <Container className="py-12">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-semibold">Top rated</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">Loved by thousands of customers.</p>
          </div>
          <Link
            to="/products"
            className="hidden text-sm font-medium text-brand-600 hover:underline sm:block dark:text-brand-300"
          >
            See all products →
          </Link>
        </div>
        <ProductGrid products={featured} />
      </Container>
    </>
  )
}
