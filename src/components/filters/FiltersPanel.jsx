import Card from '../UI/Card'
import Button from '../UI/Button'
import PriceRange from '../UI/PriceRange'
import CategoryFilter from './CategoryFilter'
import SearchBar from './SearchBar'
import SortSelect from './SortSelect'

export default function FiltersPanel({ filters, setFilter, onReset, lockCategory = false, resultCount }) {
  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Filters</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {resultCount} result{resultCount === 1 ? '' : 's'}
        </span>
      </div>
      <SearchBar value={filters.query} onChange={(v) => setFilter('query', v)} />
      <CategoryFilter
        value={filters.category}
        onChange={(v) => setFilter('category', v)}
        disabled={lockCategory}
      />
      <PriceRange min={filters.min} max={filters.max} onChange={setFilter} />
      <SortSelect value={filters.sort} onChange={(v) => setFilter('sort', v)} />
      <Button variant="outline" size="sm" onClick={onReset}>
        Reset filters
      </Button>
    </Card>
  )
}
