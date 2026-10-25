import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { QuickAskScreen } from "@/screens/quick-ask-screen";

// Daseo delta 64: `paseo://quick-ask` (side button, app shortcut). Registered outside the
// store-ready guard so a cold-start deep link is not redirected away before the store loads.
export default function QuickAskRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <QuickAskScreen />
    </HostRouteBootstrapBoundary>
  );
}
