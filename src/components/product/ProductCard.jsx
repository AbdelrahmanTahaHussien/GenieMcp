import { Link } from 'react-router-dom'
import Card from '../UI/Card'
import Badge from '../UI/Badge'
import Rating from '../UI/Rating'
import Button from '../UI/Button'
import Price from '../UI/Price'
import { findCategory } from '../../data/categories'

export default function ProductCard({ product, onAdd }) {
  const category = findCategory(product.category)
  return (
    <Card className="group flex flex-col overflow-hidden">
      <Link to={`/products/${product.id}`} className="block overflow-hidden">
        <div className="aspect-square overflow-hidden bg-slate-100 dark:bg-slate-800">
          <img
            src={product.image}
            alt={product.title}
            loading="lazy"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        </div>
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center justify-between">
          {category && <Badge tone="brand">{category.name}</Badge>}
          <Rating value={product.rating} />
        </div>
        <Link
          to={`/products/${product.id}`}
          className="line-clamp-2 text-sm font-medium text-slate-900 hover:text-brand-600 dark:text-white dark:hover:text-brand-300"
        >
          {product.title}
        </Link>
        <div className="mt-auto flex items-center justify-between pt-3">
          <Price value={product.price} />
          <Button size="sm" onClick={() => onAdd?.(product)} aria-label={`Add ${product.title} to cart`}>
            Add to cart
          </Button>
        </div>
      </div>
    </Card>
  )
}
