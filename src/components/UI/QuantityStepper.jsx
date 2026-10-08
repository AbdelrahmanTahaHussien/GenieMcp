import Button from './Button'

export default function QuantityStepper({ value, onIncrement, onDecrement, min = 1, max = 99 }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-700">
      <Button
        variant="ghost"
        size="sm"
        onClick={onDecrement}
        disabled={value <= min}
        aria-label="Decrease quantity"
        className="rounded-r-none"
      >
        −
      </Button>
      <span className="min-w-8 px-3 text-center text-sm font-medium text-slate-900 dark:text-slate-100">
        {value}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onIncrement}
        disabled={value >= max}
        aria-label="Increase quantity"
        className="rounded-l-none"
      >
        +
      </Button>
    </div>
  )
}
