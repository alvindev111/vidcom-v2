// Copy of src/app/api/[[...route]]/route.ts's shape: the thing R4.11 says makes
// `next build` fail under output: 'export'.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = () => new Response("ok");

export { handler as GET };
export { handler as POST };
export { handler as PUT };
export { handler as PATCH };
export { handler as DELETE };
export { handler as OPTIONS };
