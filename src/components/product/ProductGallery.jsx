export default function ProductGallery({ image, alt }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-800">
      <img src={image} alt={alt} className="aspect-square w-full object-cover" />
    </div>
  )
}
