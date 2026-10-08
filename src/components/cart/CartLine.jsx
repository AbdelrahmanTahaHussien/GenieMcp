import { Link } from 'react-router-dom'
import Button from '../UI/Button'
import QuantityStepper from '../UI/QuantityStepper'
import Price from '../UI/Price'

export default function CartLine({ line, onIncrement, onDecrement, onRemove }) {
  const { product, quantity, lineTotal } = line
  return (
    <div className="flex items-start gap-4 border-b border-slate-200 py-4 last:border-b-0 dark:border-slate-800">
      <Link to={`/products/${product.id}`} className="flex-shrink-0">
        <img
          src={product.image}
          alt={product.title}
          className="h-20 w-20 rounded-lg object-cover sm:h-24 sm:w-24"
        />
      </Link>
      <div className="flex flex-1 flex-col gap-2">
        <Link
          to={`/products/${product.id}`}
          className="text-sm font-medium text-slate-900 hover:text-brand-600 dark:text-white"
        >
          {product.title}
        </Link>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          <Price value={product.price} className="text-xs font-normal text-slate-500 dark:text-slate-400" /> each
        </div>
        <div className="mt-1 flex items-center gap-3">
          <QuantityStepper
            value={quantity}
            onIncrement={() => onIncrement(product.id)}
            onDecrement={() => onDecrement(product.id)}
          />
          <Button variant="ghost" size="sm" onClick={() => onRemove(product.id)}>
            Remove
          </Button>
        </div>
      </div>
      <div className="text-right">
        <Price value={lineTotal} />
      </div>
    </div>
  )
}
