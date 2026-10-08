import Input from '../UI/Input'

export default function SearchBar({ value, onChange }) {
  return (
    <Input
      id="search"
      label="Search"
      type="search"
      placeholder="Search products…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
