# CLAUDE.md — rn-local-llm

Working name. Rename before first publish.

## What this is

A React Native library that lets an app run a small language model **on the device**, offline, in a few lines of code.

```ts
const model = useLocalModel('qwen3-1.7b-q4');
const reply = await model.generate('Summarize this note: ...');
```

## The thesis (read this before proposing anything)

Inference is a solved problem. ExecuTorch and llama.cpp already run these models well.

**The unsolved problem is the operations layer around inference.** Getting a 1.2 GB file onto a phone, keeping it there, versioning it, and not crashing a 4 GB Android device when the user opens the camera mid-generation.

That layer is the entire value of this library. Every design decision defaults toward reliability over features.

If a task feels boring and infrastructural, it is probably the most important task in the repo.

## Non-goals

Do not build these. If asked, push back and cite this section.

- A chat UI, message bubbles, or any component library
- A model training or fine-tuning pipeline
- Our own inference engine
- RAG, vector stores, or embeddings (a later package, not this one)
- Agent frameworks or tool-calling orchestration
- Web or Node support — React Native mobile only, iOS and Android

## Locked architecture decisions

Do not revisit these without explicit approval.

1. **New Architecture only.** TurboModules + JSI. No bridge, no legacy fallback.
2. **Two backends behind one interface.** `ExecuTorchBackend` and `LlamaCppBackend` both implement `InferenceBackend`. Nothing above that interface may know which is active.
3. **GGUF and `.pte` are both first-class.** Model manifests declare which backend they require.
4. **One model resident at a time.** A global load lock. Loading a second model unloads the first. This is not a limitation to fix later — it is the memory contract.
5. **Everything async is cancellable.** Every download, load, and generation returns a handle with `.cancel()`. No exceptions.
6. **Native code is thin.** Business logic lives in TypeScript. Native layers do memory-sensitive and platform-API work only.

## The pieces that matter

### Model registry
A manifest describes each model: id, backend, quantization, file size, SHA-256, minimum device RAM, and context length. Manifests are static JSON, resolvable from a URL or bundled locally. Never trust a downloaded file that fails checksum.

### Downloader
Must survive real-world conditions:
- Resumable via HTTP range requests
- True background transfer (`URLSession` background config on iOS, `WorkManager` on Android)
- Free-disk precheck before starting, with headroom margin
- Wi-Fi-only mode as the default, cellular opt-in
- Download to a temp path, verify checksum, then atomically move into place
- Survives force-quit mid-download and resumes on next launch

### Memory guard
The part most likely to earn the library its reputation:
- Preflight: read available RAM, compare against manifest minimum, refuse the load with a typed error rather than crashing
- Subscribe to OS memory-pressure signals and unload proactively
- Unload on app background by default, configurable
- Never let two models be resident simultaneously
- Explicitly test on a 4 GB Android device — that is the target, not a flagship

### Fallback policy
An optional escape hatch to a remote endpoint. Must be explicit configuration, never automatic and never silent. The consumer always knows whether a response came from the device or the network — surface it on the result object.

### Streaming
Tokens stream through a JSI callback, not an event emitter over the bridge. Backpressure handled. Cancellation mid-stream must free native resources within one token.

## Repo layout

```
/src            TypeScript public API, registry, download orchestration, state machine
/ios            Swift TurboModule, ExecuTorch + llama.cpp bindings
/android        Kotlin TurboModule, JNI bindings
/cpp            Shared JSI layer
/example        Expo dev-client app used for real-device testing
/benchmarks     Device matrix results, committed as JSON
```

## Milestones

**M0 — Skeleton.** TurboModule builds and runs on both platforms. `getDeviceCapabilities()` returns real RAM, chip, and available accelerators. Nothing else.

**M1 — One model, one backend, end to end.** llama.cpp + a single GGUF. Hardcoded path, no download. Prove tokens stream on a real device.

**M2 — The operations layer.** Registry, downloader, checksum verification, memory guard, load lock. This is the milestone the project exists for. Expect it to take longer than M1 and M3 combined.

**M3 — Second backend.** ExecuTorch behind the same interface. If adding it requires changing anything above `InferenceBackend`, the abstraction was wrong — fix the abstraction.

**M4 — Public API polish.** Hooks, docs, example app, benchmark table.

Do not start a milestone before the previous one has its tests passing on physical hardware.

## Engineering rules

- TypeScript strict mode. No `any`, no non-null assertions.
- **Typed errors, always.** A discriminated union: `InsufficientMemory`, `ModelNotFound`, `ChecksumMismatch`, `DownloadInterrupted`, `BackendUnavailable`, `Cancelled`, `ContextOverflow`. Never throw a bare string. Never swallow an error to keep a happy path clean.
- Every public function documents its failure modes in TSDoc.
- No new runtime dependencies without justification. This library will be installed by people who care about bundle size.
- Native memory allocations must have a documented owner and release path.
- Log through an injectable logger; never `console.log` in shipped code.

## Testing

Unit tests on TypeScript logic are necessary but prove almost nothing here. The bugs live in the field conditions below, and every one of them must have a test or a documented manual procedure:

- Airplane mode toggled mid-download
- Disk fills during download
- App force-quit mid-download, then relaunched
- App backgrounded mid-generation
- Second model requested while the first is loading
- 4 GB Android device, memory pressure induced by opening the camera
- Thermal throttling during sustained generation
- Corrupted model file on disk (flip a byte and verify the checksum catches it)

Benchmarks go in `/benchmarks` as committed JSON: device, model, quantization, tokens/sec, peak RSS, time-to-first-token. Real devices only. No simulator numbers, ever.

## Working style

- Ask before adding a dependency, adding a public API surface, or changing anything in the locked-decisions list.
- When a design has two reasonable paths, write both options with tradeoffs and stop for a decision. Do not pick silently.
- Prefer a small correct slice over a broad scaffold. A working download resume beats five stubbed modules.
- When something can't be tested on a simulator, say so plainly rather than writing a test that passes vacuously.
- If you notice the project drifting toward being an inference wrapper rather than an operations layer, say so.

## Definition of done for any change

1. Builds clean on iOS and Android
2. Runs on a physical device, not just a simulator
3. Failure paths return typed errors
4. Native resources release on cancel and on unmount
5. Public API changes are documented with failure modes
6. Example app exercises the new path

---

# Current state

Everything above is **intent**. Everything below is **fact**, as of 2026-08-08.
Read this section before proposing work — it tells you what exists, what is
proven, and what your environment can and cannot verify.

Update this section when it stops being true. A stale state section is worse
than none, because it will be believed.

## Where the milestones actually stand

| Milestone | State |
|---|---|
| M0 — Skeleton | **Not started.** No native code exists. `/ios`, `/android`, `/cpp`, `/example`, `/benchmarks` do not exist. This environment has no `xcodebuild`, `sdkmanager`, or `adb` — M0 is unstartable here, not just unstarted. |
| M1 | Not started. Blocked on M0. |
| M2 — The operations layer | **Partially started, deliberately out of milestone order** (see "Decisions already made" below). Built so far, as pure TypeScript with no native dependency: the model manifest schema + validation, the model registry, the memory guard's preflight decision logic, and checksum-mismatch detection. **Not built:** the downloader (needs native background transfer — URLSession/WorkManager — which needs M0), actual SHA-256 hashing of a file (needs a crypto library — an open dependency decision, see below), OS memory-pressure subscription (needs native), unload-on-background (needs native). |
| M3–M4 | Not started. Blocked on M0 and M2. |
| Cross-cutting | Typed error union: **done and verified.** All 7 documented kinds (`InsufficientMemory`, `ModelNotFound`, `ChecksumMismatch`, `DownloadInterrupted`, `BackendUnavailable`, `Cancelled`, `ContextOverflow`) have classes; both exhaustiveness guards (`EveryKindHasAClass` in `errors.ts`, `SAMPLES` in `errors.test.ts`) were manually broken and confirmed to fail the build, then restored. |

## What exists

```
CLAUDE.md               this file
README.md               public-facing summary (still the placeholder heading)
LICENSE                 MIT
package.json             private, 0.0.0, zero runtime dependencies
tsconfig.json            strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noEmit
src/errors.ts            the typed error union (7 kinds)
src/errors.test.ts       69 assertions
src/manifest.ts          ModelManifest type + validateManifest() (hand-rolled, no schema library)
src/manifest.test.ts     13 assertions
src/registry.ts          ModelRegistry: register/resolve/list/fromManifestList
src/registry.test.ts     7 assertions
src/memoryGuard.ts       checkMemoryCapability() — pure decision logic, RAM reading itself is native/M0 work
src/memoryGuard.test.ts  5 assertions
src/checksum.ts          assertChecksumMatches() — pure comparison, hashing itself needs a crypto dependency
src/checksum.test.ts     3 assertions
src/index.ts             public entry point, re-exports the above
```

`npm run check` (typecheck + `node --test`) passes: 97 assertions, 0 failures.
There is still no build step — `tsconfig.json` is `noEmit` and the package is
`private`. Both still need to change before this can be published or consumed
by an app; see open question 3 below, which is unresolved.

## Verify your environment before planning work

Run `npm run check`. It needs **Node >= 22.18** — tests run on `node:test`
using native type stripping (confirmed working in this environment on Node
22.22.2), which is why the repo has no test-runner dependency.

**A gotcha this took a moment to work out:** relative imports must use a
literal `.ts` extension (e.g. `import { x } from './errors.ts'`), not `.js`.
`tsconfig.json` sets `allowImportingTsExtensions` to permit this under
`--noEmit`. The more common TS convention — importing with a `.js` extension
and letting a bundler or `ts-node`-style loader resolve it to the `.ts` file —
does **not** work with Node's native type stripping on this Node version: a
`.js` specifier only resolves to an actual `.js` file, so it throws
`ERR_MODULE_NOT_FOUND` when only `errors.ts` exists on disk. Confirmed by
testing both ways before settling on `.ts` imports everywhere in `src/`.

Then establish what you can actually verify beyond the TypeScript layer:

```
xcodebuild -version      # iOS builds
sdkmanager --list        # Android builds
adb devices               # physical hardware
```

**If those are missing, you cannot complete M0, or any milestone that touches
native code.** This environment has none of them — confirmed by running all
three and getting nothing back. Definition of done items 1 and 2 are
unverifiable here. Say so plainly rather than writing native code blind and
calling it done; that's why no `/ios`, `/android`, or `/cpp` files exist yet.

## Decisions already made — do not silently revisit

- **The M2 ops-layer TypeScript was built ahead of M0**, explicitly, by user
  decision on 2026-08-08 (open question 1 below is now resolved, not open).
  The reasoning: this environment has no device and no native toolchain, so
  M0 cannot be completed here regardless of ordering: building the
  pure-TypeScript, fully-testable-without-a-device slice of M2 was judged
  better than writing native scaffolding that couldn't be compiled or run.
  Revisit this only if the environment changes (a device/toolchain becomes
  available) or the user says otherwise.
- **Errors subclass `Error`** rather than being plain union objects, for the
  reasons the original draft of this section gave: crash-reporter stack
  capture, `instanceof`, and Sentry/Crashlytics grouping. Verified for real
  this time — `errors.test.ts` has a dedicated `instanceof` test through a
  throw/catch, not just direct construction.
- **`Object.setPrototypeOf(this, new.target.prototype)` in the base
  constructor**, using `new.target` rather than a hardcoded class — this way
  it stays correct no matter how many subclass levels sit below
  `LocalLlmErrorBase`. Do not remove it as dead code.
- **`toJSON()` omits `cause`** — it may hold an unserializable native object.
- **License is MIT.**
- **Dev dependencies are `typescript` (7.0.2) and `@types/node` (26.2.0), and
  nothing else.** Runtime dependencies remain zero.
- **Package is ESM (`"type": "module"`) and `private: true`.** Private
  because there's no build yet and native code doesn't exist — publishing now
  would ship a package no app can actually load a model with.
- **Manifest validation is hand-rolled**, not backed by a schema library
  (zod, ajv, etc.). A validation library is a runtime dependency that hasn't
  been asked about; the validation logic here is simple enough (flat field
  checks, one nested `source` object) that hand-rolling it isn't a real cost.
  Revisit if the schema grows more nested/conditional than this.
- **Checksum verification is split in two, and only half is built.**
  `assertChecksumMatches()` in `checksum.ts` is pure comparison logic —
  given an expected and an actual SHA-256, decide match or
  `ChecksumMismatchError`. Actually *computing* the actual hash from file
  bytes needs a hashing implementation RN doesn't have built in (`node:crypto`
  isn't available on-device); no crypto library has been chosen. This is the
  next real dependency decision, not made here.
- **The downloader itself was not built.** "True background transfer" is a
  native requirement (`URLSession` background config, `WorkManager`) — there
  is no TS-only version of this that would be real rather than a stub, and
  this file's own working style says a working slice beats a stubbed one.

## Open questions — decide before building

1. ~~Can the ops-layer TypeScript run ahead of M0?~~ **Resolved 2026-08-08:
   yes**, explicitly, given this environment's lack of a device. See
   "Decisions already made" above.
2. **Rename before publish.** Still unresolved — user chose to keep
   `rn-local-llm` for now (decided 2026-08-08) and revisit before publishing.
3. **No build yet.** `package.json` has no `exports` map and `tsconfig.json`
   is `noEmit`. Needs a decision — a bundler (tsup, unbuild) vs. plain `tsc`
   emit, and an `exports` map shape — before the package is `private: false`
   or consumable by an app. Not needed yet since M0/the example app don't
   exist to consume it.
4. **Crypto/hashing dependency for on-device SHA-256.** New — surfaced while
   building `checksum.ts`. Candidates would need to be evaluated for RN
   compatibility (New Architecture, no bridge) and bundle size before asking
   to add one; not evaluated yet.
5. **Download transport dependency, if any.** New — surfaced while scoping
   the downloader. Native background transfer likely wants a maintained RN
   library (e.g. something building on `react-native-background-fetch` or a
   from-scratch TurboModule) rather than hand-rolled `URLSession`/`WorkManager`
   glue; not evaluated, and blocked on M0 regardless.
