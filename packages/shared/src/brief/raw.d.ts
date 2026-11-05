// Lets tests import a fixture as text with Vite's `?raw` suffix (the shared package has no Node
// types, so it cannot read files itself).
declare module '*?raw' {
  const content: string;
  export default content;
}
