import React from "react";

// v2 manager — same component name as the v1 file, different folder. The graph
// must keep these as two distinct nodes (v1/RechargeManager, v2/RechargeManager)
// even though both are reached only through lazy() dynamic imports.
export default function RechargeManager() {
  return <section>recharge v2</section>;
}
