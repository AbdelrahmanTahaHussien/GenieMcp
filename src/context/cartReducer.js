export const initialCart = { items: [] }

export function cartReducer(state, action) {
  switch (action.type) {
    case 'ADD': {
      const { productId, quantity = 1 } = action
      const existing = state.items.find((i) => i.productId === productId)
      const items = existing
        ? state.items.map((i) =>
            i.productId === productId ? { ...i, quantity: i.quantity + quantity } : i
          )
        : [...state.items, { productId, quantity }]
      return { ...state, items }
    }
    case 'REMOVE':
      return { ...state, items: state.items.filter((i) => i.productId !== action.productId) }
    case 'INCREMENT':
      return {
        ...state,
        items: state.items.map((i) =>
          i.productId === action.productId ? { ...i, quantity: i.quantity + 1 } : i
        ),
      }
    case 'DECREMENT':
      return {
        ...state,
        items: state.items
          .map((i) =>
            i.productId === action.productId ? { ...i, quantity: i.quantity - 1 } : i
          )
          .filter((i) => i.quantity > 0),
      }
    case 'CLEAR':
      return { ...state, items: [] }
    case 'HYDRATE':
      return action.state ?? state
    default:
      return state
  }
}
