import { useContext, useMemo } from 'react'
import { CartContext } from '../context/cartContextInstance'
import { findProduct } from '../data/products'

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>')

  const { state, dispatch } = ctx

  const detailed = useMemo(
    () =>
      state.items
        .map((line) => {
          const product = findProduct(line.productId)
          if (!product) return null
          return { ...line, product, lineTotal: product.price * line.quantity }
        })
        .filter(Boolean),
    [state.items]
  )

  const count = useMemo(() => detailed.reduce((sum, l) => sum + l.quantity, 0), [detailed])
  const total = useMemo(() => detailed.reduce((sum, l) => sum + l.lineTotal, 0), [detailed])

  return {
    items: detailed,
    count,
    total,
    add: (productId, quantity = 1) => dispatch({ type: 'ADD', productId, quantity }),
    remove: (productId) => dispatch({ type: 'REMOVE', productId }),
    increment: (productId) => dispatch({ type: 'INCREMENT', productId }),
    decrement: (productId) => dispatch({ type: 'DECREMENT', productId }),
    clear: () => dispatch({ type: 'CLEAR' }),
  }
}
