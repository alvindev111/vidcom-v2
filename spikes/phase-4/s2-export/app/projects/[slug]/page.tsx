// Server component: `output: 'export'` demands generateStaticParams on a
// dynamic route, and Next refuses that export from a "use client" file. So the
// page splits — a server shell that emits ONE placeholder HTML, and the client
// component that was the whole page before.
//
// The slug is not knowable at build time (users create projects at runtime), so
// the shell is served by the SEA host for every /projects/* path and the client
// reads the real slug from location.
import { StudioClient } from "./studio-client";

export function generateStaticParams() {
  return [{ slug: "__shell" }];
}

export default function StudioPage() {
  return <StudioClient />;
}
