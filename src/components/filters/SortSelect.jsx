import Select from '../UI/Select'
import { SORT_OPTIONS } from '../../hooks/useProductFilters'

export default function SortSelect({ value, onChange }) {
  return (
    <Select
      id="sort"
      label="Sort by"
      options={SORT_OPTIONS}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
