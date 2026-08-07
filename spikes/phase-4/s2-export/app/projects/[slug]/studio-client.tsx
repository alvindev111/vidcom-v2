"use client";
import * as React from "react";

// The real page body. Everything the product's studio page does today lives
// here unchanged; only the generateStaticParams export had to move out.
export function StudioClient() {
  const [slug, setSlug] = React.useState("");
  React.useEffect(() => {
    setSlug(window.location.pathname.replace(/^\/projects\//, "").replace(/\/$/, ""));
  }, []);
  return <main data-testid="studio">STUDIO slug={slug}</main>;
}
