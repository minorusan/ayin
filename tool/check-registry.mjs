/**
 * prepublishOnly guard — never publish `ayin` to public npm.
 *
 * `package.json` used to carry `publishConfig.registry` pointing at a private LAN address, which
 * published the author's internal addressing scheme along with the package (and made a clone's `npm
 * publish` aim at a host that isn't theirs). Removing it leaves publishing to whatever registry npm is
 * configured with — which is right, but means a machine configured for public npm would try to publish
 * there, and on public npm `ayin` belongs to **a different, unrelated package**. That is a mistake you
 * cannot take back.
 *
 * So: refuse public npm, and refuse the default when it IS public npm. Pass the target explicitly:
 *   npm publish --registry http://<your-registry>
 *   AYIN_REGISTRY=http://<your-registry> npm run release
 */

const registry = process.env.npm_config_registry ?? '';
const PUBLIC = /^https?:\/\/(registry\.)?npmjs\.(org|com)\/?$/i;

if (!registry) {
  console.error('[check-registry] cannot determine the target registry — refusing to publish.');
  console.error('  Pass one explicitly:  npm publish --registry http://<your-registry>');
  process.exit(1);
}

if (PUBLIC.test(registry)) {
  console.error(`[check-registry] REFUSING to publish to public npm (${registry}).`);
  console.error('  "ayin" on npmjs.org is an unrelated package owned by someone else.');
  console.error('  Publish to your own registry:  npm publish --registry http://<your-registry>');
  process.exit(1);
}

console.log(`[check-registry] ok — publishing to ${registry}`);
