import { useParams } from 'react-router-dom'
import { findCategory } from '../data/categories'
import ProductsPage from './ProductsPage'
import NotFoundPage from './NotFoundPage'

export default function CategoryPage() {
  const { slug } = useParams()
  const category = findCategory(slug)
  if (!category) return <NotFoundPage />
  return (
    <ProductsPage
      key={category.slug}
      title={category.name}
      subtitle={category.blurb}
      initialCategory={category.slug}
      lockCategory
    />
  )
}
