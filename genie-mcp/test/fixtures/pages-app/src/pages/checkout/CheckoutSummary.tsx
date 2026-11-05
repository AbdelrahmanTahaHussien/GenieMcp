import { Button } from "../../components/Button";
import { useCart } from "../../hooks/useCart";

export function CheckoutSummary() {
  useCart();
  return <Button label="Pay" />;
}
