import React, { lazy } from "react";
import { Button } from "@components";
import V2Button from "./components/ui-v2/Button/Button";

// Lazily-loaded page — reached only via dynamic import().
const LazyPage = lazy(() => import("./pages/LazyPage"));

// Two lazily-loaded managers whose default exports share the name
// `RechargeManager` but live in different folders. Both edges must survive as
// distinct, path-qualified nodes — not collapse into one.
const RechargeV1 = lazy(() => import("./pages/recharge/v1/RechargeManager"));
const RechargeV2 = lazy(() => import("./pages/recharge/v2/RechargeManager"));

export default function App() {
  return (
    <div>
      <Button label="hi" />
      <V2Button text="hey" />
      <LazyPage />
      <RechargeV1 />
      <RechargeV2 />
    </div>
  );
}
