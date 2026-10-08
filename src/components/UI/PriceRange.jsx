import Input from './Input'

export default function PriceRange({ min, max, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Input
        id="price-min"
        label="Min $"
        type="number"
        min="0"
        inputMode="numeric"
        placeholder="0"
        value={min}
        onChange={(e) => onChange('min', e.target.value)}
      />
      <Input
        id="price-max"
        label="Max $"
        type="number"
        min="0"
        inputMode="numeric"
        placeholder="Any"
        value={max}
        onChange={(e) => onChange('max', e.target.value)}
      />
    </div>
  )
}
