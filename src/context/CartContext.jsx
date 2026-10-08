import { useEffect, useReducer } from 'react'
import { cartReducer, initialCart } from './cartReducer'
import { CartContext } from './cartContextInstance'

const STORAGE_KEY = 'celfronteders-cart'

function lazyInit() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialCart
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.items)) return initialCart
    return parsed
  } catch {
    return initialCart
  }
}

export function CartProvider({ children }) {
  const [state, dispatch] = useReducer(cartReducer, undefined, lazyInit)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* ignore */
    }
  }, [state])

  return <CartContext.Provider value={{ state, dispatch }}>{children}</CartContext.Provider>
}
