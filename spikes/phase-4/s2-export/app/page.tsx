"use client";
import * as React from "react";

// Mirrors src/app/page.tsx: client component that fetches on mount.
export default function Home() {
  const [state, setState] = React.useState("loading");
  React.useEffect(() => {
    fetch("/api/v1/projects").then((r) => setState(String(r.status))).catch(() => setState("error"));
  }, []);
  return <main data-testid="home">HOME {state}</main>;
}
