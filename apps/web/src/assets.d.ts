/**
 * Importing an image asset yields its served URL (Bun's bundler resolves it to
 * a content-addressed path).
 */
declare module "*.gif" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}
