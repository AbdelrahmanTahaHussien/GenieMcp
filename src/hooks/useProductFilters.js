import { useCallback, useMemo, useState } from 'react'

export const SORT_OPTIONS = [
  { value: 'featured', label: 'Featured' },
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
  { value: 'name-asc', label: 'Name: A → Z' },
  { value: 'rating-desc', label: 'Top rated' },
]

const defaultFilters = {
  category: '',
  min: '',
  max: '',
  query: '',
  sort: 'featured',
}

function sortProducts(list, sort) {
  const copy = [...list]
  switch (sort) {
    case 'price-asc':
      return copy.sort((a, b) => a.price - b.price)
    case 'price-desc':
      return copy.sort((a, b) => b.price - a.price)
    case 'name-asc':
      return copy.sort((a, b) => a.title.localeCompare(b.title))
    case 'rating-desc':
      return copy.sort((a, b) => b.rating - a.rating)
    default:
      return copy
  }
}

export function useProductFilters(products, overrides = {}) {
  const [filters, setFilters] = useState({ ...defaultFilters, ...overrides })

  const setFilter = useCallback((key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  const reset = useCallback(() => setFilters({ ...defaultFilters, ...overrides }), [overrides])

  const filtered = useMemo(() => {
    const min = filters.min === '' ? null : Number(filters.min)
    const max = filters.max === '' ? null : Number(filters.max)
    const q = filters.query.trim().toLowerCase()
    const list = products.filter((p) => {
      if (filters.category && p.category !== filters.category) return false
      if (min !== null && p.price < min) return false
      if (max !== null && p.price > max) return false
      if (q && !p.title.toLowerCase().includes(q)) return false
      return true
    })
    return sortProducts(list, filters.sort)
  }, [products, filters])

  return { filters, setFilter, reset, filtered }
}
