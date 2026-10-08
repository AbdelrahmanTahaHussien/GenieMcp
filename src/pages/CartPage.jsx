import { Link } from 'react-router-dom'
import Container from '../components/UI/Container'
import Card from '../components/UI/Card'
import Button from '../components/UI/Button'
import EmptyState from '../components/UI/EmptyState'
import CartLine from '../components/cart/CartLine'
import CartSummary from '../components/cart/CartSummary'
import { useCart } from '../hooks/useCart'

export default function CartPage() {
  const { items, count, total, increment, decrement, remove, clear } = useCart()

  const handleCheckout = () => {
    window.alert(`Demo checkout for ${count} item(s). Thanks for trying celfronteders!`)
    clear()
  }

  return (
    <Container className="py-10">
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">Your cart</h1>

      {items.length === 0 ? (
        <EmptyState
          icon="🛒"
          title="Your cart is empty"
          message="Browse the catalog and add a few things you love."
          action={
            <Link to="/products">
              <Button>Start shopping</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card className="p-2 sm:p-4">
            {items.map((line) => (
              <CartLine
                key={line.productId}
                line={line}
                onIncrement={increment}
                onDecrement={decrement}
                onRemove={remove}
              />
            ))}
          </Card>
          <CartSummary count={count} total={total} onCheckout={handleCheckout} onClear={clear} />
        </div>
      )}
    </Container>
  )
}
