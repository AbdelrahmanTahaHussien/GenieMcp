import ProductCard from './ProductCard'
import EmptyState from '../UI/EmptyState'
import { useCart } from '../../hooks/useCart'

export default function ProductGrid({ products }) {
  const { add } = useCart()
  if (!products.length) {
    return (
      <EmptyState
        icon="🔍"
        title="No products match your filters"
        message="Try removing a filter or broadening your price range."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} onAdd={(p) => add(p.id)} />
      ))}
    </div>
  )
}
