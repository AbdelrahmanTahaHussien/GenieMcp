import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Container from '../components/UI/Container'
import Button from '../components/UI/Button'
import Badge from '../components/UI/Badge'
import Rating from '../components/UI/Rating'
import Price from '../components/UI/Price'
import QuantityStepper from '../components/UI/QuantityStepper'
import EmptyState from '../components/UI/EmptyState'
import ProductGallery from '../components/product/ProductGallery'
import ProductGrid from '../components/product/ProductGrid'
import { findProduct, products } from '../data/products'
import { findCategory } from '../data/categories'
import { useCart } from '../hooks/useCart'

export default function ProductDetailPage() {
  const { id } = useParams()
  const product = findProduct(id)
  const [quantity, setQuantity] = useState(1)
  const { add } = useCart()

  if (!product) {
    return (
      <Container className="py-16">
        <EmptyState
          icon="🤷"
          title="Product not found"
          message="This product may have been removed or never existed."
          action={
            <Link to="/products">
              <Button>Back to products</Button>
            </Link>
          }
        />
      </Container>
    )
  }

  const category = findCategory(product.category)
  const related = products
    .filter((p) => p.category === product.category && p.id !== product.id)
    .slice(0, 4)

  return (
    <Container className="py-10">
      <nav className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        <Link to="/" className="hover:text-brand-600">
          Home
        </Link>{' '}
        ·{' '}
        <Link to="/products" className="hover:text-brand-600">
          Products
        </Link>
        {category && (
          <>
            {' '}
            ·{' '}
            <Link to={`/category/${category.slug}`} className="hover:text-brand-600">
              {category.name}
            </Link>
          </>
        )}
      </nav>

      <div className="grid gap-10 lg:grid-cols-2">
        <ProductGallery image={product.image} alt={product.title} />
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            {category && <Badge tone="brand">{category.name}</Badge>}
            <Rating value={product.rating} />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">{product.title}</h1>
          <Price value={product.price} className="text-2xl" />
          <p className="text-slate-600 dark:text-slate-300">{product.description}</p>

          <div className="flex items-center gap-2 text-sm">
            {product.stock > 0 ? (
              <Badge tone="success">In stock · {product.stock} left</Badge>
            ) : (
              <Badge tone="danger">Out of stock</Badge>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <QuantityStepper
              value={quantity}
              onIncrement={() => setQuantity((q) => Math.min(q + 1, product.stock || 99))}
              onDecrement={() => setQuantity((q) => Math.max(q - 1, 1))}
            />
            <Button
              size="lg"
              disabled={product.stock === 0}
              onClick={() => add(product.id, quantity)}
            >
              Add {quantity} to cart
            </Button>
          </div>
        </div>
      </div>

      {related.length > 0 && (
        <section className="mt-16">
          <h2 className="mb-6 text-xl font-semibold">More in {category?.name}</h2>
          <ProductGrid products={related} />
        </section>
      )}
    </Container>
  )
}
