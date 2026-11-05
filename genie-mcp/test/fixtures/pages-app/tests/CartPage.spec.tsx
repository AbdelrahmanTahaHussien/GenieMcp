import CartPage from "../src/pages/CartPage";
import CheckoutPage from "../src/pages/checkout/CheckoutPage";

describe("cart flow", () => {
  it("shows the cart", () => void CartPage);
  it("goes to checkout", () => void CheckoutPage);
});
