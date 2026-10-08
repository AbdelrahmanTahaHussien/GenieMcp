import { Link } from 'react-router-dom'
import Container from '../components/UI/Container'
import Button from '../components/UI/Button'
import EmptyState from '../components/UI/EmptyState'

export default function NotFoundPage() {
  return (
    <Container className="py-16">
      <EmptyState
        icon="🧭"
        title="Page not found"
        message="The page you're looking for doesn't exist or was moved."
        action={
          <Link to="/">
            <Button>Back to home</Button>
          </Link>
        }
      />
    </Container>
  )
}
