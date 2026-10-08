import Card from '../UI/Card'
import Button from '../UI/Button'
import Price from '../UI/Price'

export default function CartSummary({ count, total, onCheckout, onClear }) {
  const shipping = total > 100 || total === 0 ? 0 : 9.99
  const tax = +(total * 0.08).toFixed(2)
  const grand = +(total + shipping + tax).toFixed(2)
  return (
    <Card className="sticky top-24 flex flex-col gap-4 p-6">
      <h2 className="text-lg font-semibold">Order summary</h2>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500 dark:text-slate-400">
            Subtotal ({count} item{count === 1 ? '' : 's'})
          </dt>
          <dd>
            <Price value={total} />
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500 dark:text-slate-400">Shipping</dt>
          <dd>{shipping === 0 ? <span className="text-emerald-600">Free</span> : <Price value={shipping} />}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500 dark:text-slate-400">Estimated tax</dt>
          <dd>
            <Price value={tax} />
          </dd>
        </div>
        <div className="mt-2 flex justify-between border-t border-slate-200 pt-3 text-base font-semibold dark:border-slate-800">
          <dt>Total</dt>
          <dd>
            <Price value={grand} />
          </dd>
        </div>
      </dl>
      <Button size="lg" onClick={onCheckout} disabled={count === 0}>
        Checkout
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear} disabled={count === 0}>
        Clear cart
      </Button>
    </Card>
  )
}
