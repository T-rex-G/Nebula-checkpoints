export async function GET({ url }) {
  const target = url.searchParams.get('target');
  const response = await fetch(target); // expect: SEC-021
  return new Response(await response.text());
}
