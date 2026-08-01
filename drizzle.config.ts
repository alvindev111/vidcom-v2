import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/adapter/src/db/schema.ts",
  out: "./packages/adapter/drizzle",
  dbCredentials: { url: "./.temp-documents/drizzle-kit.sqlite" },
});
