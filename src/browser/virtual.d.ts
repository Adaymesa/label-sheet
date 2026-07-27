/** Resolved at build time by the esbuild plugin in scripts/build.ts. */
declare module 'virtual:pdf-worker' {
  const source: string;
  export default source;
}

/** Every pdf.js CMap, base64-encoded. Resolved at build time by scripts/build.ts. */
declare module 'virtual:cmaps' {
  const cmaps: Record<string, string | undefined>;
  export default cmaps;
}
