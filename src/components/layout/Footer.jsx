import Container from '../UI/Container'

export default function Footer() {
  return (
    <footer className="mt-16 border-t border-slate-200 py-10 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
      <Container className="flex flex-col items-center justify-between gap-4 sm:flex-row">
        <p>© {new Date().getFullYear()} celfronteders. Demo storefront.</p>
        <p>Built with React + Vite + Tailwind.</p>
      </Container>
    </footer>
  )
}
