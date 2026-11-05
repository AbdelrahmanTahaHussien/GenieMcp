import React from "react";

// Legacy manager — default export deliberately shares its name with the v2 file
// below, to exercise lazy-edge disambiguation of same-named dynamic imports.
export default function RechargeManager() {
  return <section>recharge v1</section>;
}
