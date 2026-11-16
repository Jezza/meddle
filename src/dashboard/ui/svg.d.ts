// An SVG imported `with { type: "text" }` (see icons.tsx): its text.
declare module "*.svg" {
  const text: string;
  export default text;
}
