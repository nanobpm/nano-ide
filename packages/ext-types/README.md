# @nanobpm/nano-ide-ext-types

**TypeScript types for the `nano-ide.ext.json` extension manifest** (ADR 0007).

This is the shared type contract for authoring [Nano RAD IDE](https://nanobpm.io)
extension packs. Import it in a pack's tooling to get a typed, checked
`nano-ide.ext.json` — the same manifest shape the host parser
(`server/src/console/extensions.rs`) validates at load time.

It is a **library, not a marketplace pack**: it ships no `nano-ide.ext.json`
manifest of its own and contributes nothing to the console UI. It exists so pack
authors and the manifest validator share one source of truth for the extension
contract (lang, app, example, theme, and trigger pack kinds, plus the theme
design-token vocabulary).

## Usage

```ts
import type { ExtManifest } from "@nanobpm/nano-ide-ext-types";

const manifest: ExtManifest = {
  id: "my-pack",
  kind: "lang",
  displayName: "My language",
  // …type-checked against the ADR 0007 contract
};
```

## Install

```sh
npm install --save-dev @nanobpm/nano-ide-ext-types
```

## Licence

Apache-2.0.
