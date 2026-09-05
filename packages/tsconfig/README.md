# `@pkg/tsconfig`

Shared TypeScript settings. Every workspace extends one of these rather than
carrying its own compiler options, so strictness cannot quietly differ between
packages.

## Which one to extend

| Config         | For                                        | Emits              |
| -------------- | ------------------------------------------ | ------------------ |
| `base.json`    | the shared settings; not extended directly | no                 |
| `library.json` | packages that build to `dist/`             | yes → `dist/`      |
| `nestjs.json`  | `apps/api`, `apps/worker`                  | yes → `dist/`      |
| `react.json`   | `apps/web`                                 | no — Vite compiles |

```json
{
  "extends": "@pkg/tsconfig/nestjs.json",
  "compilerOptions": { "outDir": "./dist" },
  "include": ["src", "__tests__"]
}
```

Include `__tests__` as well as `src` — typescript-eslint parses through the
project service, so a spec outside `include` fails linting with a parsing error
rather than a type error. Where the build must stay clean of tests, add a
`tsconfig.build.json` that narrows `include` back to `src` (Nest picks it up
automatically); `apps/api` and `apps/worker` do this.

## What base turns on

`strict`, plus two that catch more than they cost:

- **`noUncheckedIndexedAccess`** — `arr[0]` is `T | undefined`. It is the reason
  index access needs a guard or `?.`, and it removes a whole class of runtime
  `undefined`.
- **`verbatimModuleSyntax`** — imports are emitted as written, so a type import
  must say `import type`. That is what stops a type-only import from pulling a
  module into a bundle at runtime.

`react.json` and `nestjs.json` both turn `verbatimModuleSyntax` **off**: JSX and
Nest's decorator metadata need TypeScript to make its own decisions about
imports.

### Which TypeScript runs where

| Workspace                                  | TypeScript     | Why                                                                                                  |
| ------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/*`, `apps/web`, `apps/e2e`, root | 7.0.x (native) | `tsc --noEmit` and the library builds only need the compiler binary                                  |
| `apps/api`, `apps/worker`                  | 6.0.x (`ts6`)  | the Nest CLI (`nest build`, `nest start`) needs the programmatic compiler API that 7.0 does not ship |
| `apps/mobile`                              | 6.0.x (`ts6`)  | Expo's lint stack (typescript-eslint) has the same dependency                                        |

The default catalog pins TypeScript 7; `apps/api`, `apps/worker` and
`apps/mobile` take `catalog:ts6` instead. Their `tsc --noEmit` therefore runs 6;
the code they compile is checked the same way, and type-aware lint runs on the
TS 7 engine regardless (oxlint-tsgolint). The catalog comment says when to
delete the split (TypeScript 7.1 restoring the API, @nestjs/cli and
eslint-config-expo accepting 7.x).

## Module resolution: NodeNext everywhere

Every preset resolves with `moduleResolution: NodeNext`, which models how Node
itself resolves. Two consequences are load-bearing:

- **Packages are ESM (`"type": "module"`), so their relative imports carry an
  explicit `.js` suffix** — `import { x } from './x.js'` in a `.ts` file. The
  suffix names the compiled neighbour; TypeScript, Vite, Vitest and tsdown all
  map it back to the `.ts` source, and no `.js` file exists under `src/`. A
  directory import is written `./dir/index.js`. This is what NodeNext demands
  of ESM files, and it is what `nest new` generates for ESM projects. JSON
  imports in ESM need `with { type: 'json' }`.
- **The Nest apps are ESM too** (`"type": "module"` since 2026-09-05), so the
  same `.js` rule applies to their relative imports and to the `@/` test alias
  (`@/user/user.service.js`). Their entry points are spelled out
  (`node dist/main.js`); an extensionless `node dist/main` is CommonJS-era
  resolution. Before the switch the apps consumed the ESM-only NestJS 12
  packages through `require(esm)`; now there is no interop layer at all. JSON
  imports in ESM need `with { type: 'json' }` (the api's seed fixture).

Why not stay on classic (`node10`) resolution: it does not describe Node, so
TypeScript 6 deprecates it and TypeScript 7 removes it, and type-aware tooling
built on the TS 7 engine (oxlint's `tsgolint`) refuses a project that uses it.
The migration happened in one PR (2026-09-05): 783 specifiers — 447 across the
six packages, 310 in `apps/api`, 26 in `apps/worker` — resolved against the
filesystem by a codemod, no source semantics changed. Two follow-on edits were
forced by resolution, not by the suffixes: `ioredis` is imported by name
(`import { Redis }`; its default export is a namespace under NodeNext), and the
throttler's `forRootAsync` needs an explicit `imports: []` (nestjs/throttler#2671).
