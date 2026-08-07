"use client";
import * as React from "react";

function currentSlug(): string {
  return window.location.pathname.replace(/^\/projects\//, "").replace(/\/$/, "");
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

// The real page body. Everything the product's studio page does today lives
// here unchanged; only the generateStaticParams export had to move out.
export function StudioClient() {
  const slug = React.useSyncExternalStore(subscribe, currentSlug, () => "");
  return <main data-testid="studio">STUDIO slug={slug}</main>;
}
