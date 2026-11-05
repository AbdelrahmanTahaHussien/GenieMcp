import { Button } from "../components/Button";
import { useCart } from "../hooks/useCart";
import NotFoundPage from "./NotFoundPage";

export default function CartPage() {
  const { items } = useCart();
  if (!items) return <NotFoundPage />;
  return <Button label={`Checkout (${items.length})`} />;
}
