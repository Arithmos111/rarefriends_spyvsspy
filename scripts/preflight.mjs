/**
 * Fail early and clearly on an unsupported Node.
 *
 * The server imports the shared simulation as TypeScript and relies on Node's native type
 * stripping, which is only enabled by default from 22.18. On an older runtime the failure is
 * an opaque syntax error inside a .ts file, so check the version before anything imports one.
 */
const MINIMUM = [22, 18, 0];
const current = process.versions.node.split(".").map(Number);

const tooOld = MINIMUM.some((least, index) => {
  const part = current[index] ?? 0;
  if (part !== least) return part < least;
  return false;
});

if (tooOld) {
  console.error(
    `\nEmbassy Run needs Node.js ${MINIMUM.join(".")} or newer, but this is ${process.versions.node}.\n\n` +
    `The server and the browser share one TypeScript simulation, and the server relies on\n` +
    `Node's native type stripping, which older releases do not enable.\n\n` +
    `  nvm install 22 && nvm use 22\n`,
  );
  process.exit(1);
}
