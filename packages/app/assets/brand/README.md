# Daseo brand assets

`daseo-mark.svg` is the single source of truth for the user-visible DΛ geometry.

Run from the repository root:

```sh
npm run brand:generate
npm run brand:check
```

The generator owns the React Native path module plus Android, PWA, favicon/status,
notification, splash, macOS, Linux, and Windows image derivatives. Do not edit those
files by hand. `generated-assets.json` records the canonical-source and derivative
hashes; the pre-commit hook and desktop build reject drift.

The upstream website under `packages/website` retains Paseo's public brand and is not
part of the personal Daseo Mac/Android product. Compatibility identifiers such as the
Paseo CLI, URL scheme, bundle name, and helper names are intentionally not branding
assets and remain unchanged.
