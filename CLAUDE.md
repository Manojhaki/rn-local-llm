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
- **Typed errors, always.** A discriminated union: `InsufficientMemory`, `ModelNotFound`, `ChecksumMismatch`, `DownloadInterrupted`, `InsufficientDiskSpace`, `BackendUnavailable`, `Cancelled`, `ContextOverflow`. Never throw a bare string. Never swallow an error to keep a happy path clean. (`InsufficientDiskSpace` was added 2026-08-09 by explicit decision — the original brief listed seven kinds and had no member for the downloader's required free-disk precheck.)
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
| M2 — The operations layer | **Partially started, deliberately out of milestone order** (see "Decisions already made" below). Built so far, as pure TypeScript with no native dependency: the model manifest schema + validation, the model registry, the memory guard's preflight decision logic, checksum-mismatch detection, the download state machine (the orchestration/retry logic, not the transport), and the global load lock (locked decision #4's "one model resident at a time," as a state machine). Also built, but **unverified beyond `tsc --noEmit`** since both depend on real native modules this environment can't link or run: `src/hashing.ts`'s `computeSha256()` and `src/downloadTransport.ts`'s `startDownload()` (`expo-file-system` + `react-native-quick-crypto`, see "Decisions already made"). The orchestrator (`downloadModel.ts`) that sequences transfer → hash → checksum → atomic move **is built and genuinely tested** — its ports are injected, so 31 assertions exercise the real retry/cancel/cleanup logic against fakes with no device. The free-disk precheck (`diskGuard.ts` + an eighth error kind, `InsufficientDiskSpace`) is built and tested too, as is the download journal (`downloadJournal.ts`) that makes force-quit resume real rather than aspirational. **Not built:** Wi-Fi-only gating (needs a network-state source, another native dependency decision), OS memory-pressure subscription (needs native), unload-on-background (needs native), and actually loading/unloading a model in a backend (needs M0/M1 — the load lock only tracks *which* model id should be resident, not the native residency itself). |
| M3–M4 | Not started. Blocked on M0 and M2. |
| Cross-cutting | Typed error union: **done and verified.** All 7 documented kinds (`InsufficientMemory`, `ModelNotFound`, `ChecksumMismatch`, `DownloadInterrupted`, `BackendUnavailable`, `Cancelled`, `ContextOverflow`) have classes; both exhaustiveness guards (`EveryKindHasAClass` in `errors.ts`, `SAMPLES` in `errors.test.ts`) were manually broken and confirmed to fail the build, then restored. |

## What exists

```
CLAUDE.md               this file
README.md               public-facing summary (still the placeholder heading)
LICENSE                 MIT
package.json             private, 0.0.0, zero direct runtime deps (2 peerDependencies, 2 matching devDependencies)
.npmrc                   omit=peer, so local `npm install` doesn't resolve the peer tree
tsconfig.json            strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noEmit (dev/typecheck)
tsconfig.build.json      emit config: dist/, declarations, rewriteRelativeImportExtensions, tests excluded
src/errors.ts            the typed error union (8 kinds)
src/errors.test.ts       78 assertions
src/manifest.ts          ModelManifest type + validateManifest() (hand-rolled, no schema library)
src/manifest.test.ts     13 assertions
src/registry.ts          ModelRegistry: register/resolve/list/fromManifestList
src/registry.test.ts     7 assertions
src/memoryGuard.ts       checkMemoryCapability() — pure decision logic, RAM reading itself is native/M0 work
src/memoryGuard.test.ts  5 assertions
src/diskGuard.ts         checkDiskCapacity() — free-disk preflight, mirrors memoryGuard.ts; reading free space is native
src/diskGuard.test.ts    11 assertions
src/checksum.ts          assertChecksumMatches() — pure comparison logic
src/checksum.test.ts     3 assertions
src/download.ts          download state machine: transition(state, event) — pure reducer, no I/O or transport
src/download.test.ts     34 assertions
src/loadLock.ts          global load lock: transitionLoadLock(state, event) — pure reducer, no native residency
src/loadLock.test.ts     20 assertions
src/downloadModel.ts     the orchestrator: downloadModel() — transfer → hash → checksum → atomic move, ports injected
src/downloadModel.test.ts 50 assertions, all against fakes — no device needed
src/downloadJournal.ts   the force-quit resume layer: reconcileJournalEntry() + write throttle + validation
src/downloadJournal.test.ts 33 assertions
src/hashing.ts           computeSha256() via expo-file-system + react-native-quick-crypto — typechecked, never run, not exported from index.ts
src/downloadTransport.ts ExpoModelTransfer implements downloadModel.ts's ModelTransfer port — typechecked, never run, not exported from index.ts
src/downloadJournalStore.ts ExpoDownloadJournalStore, one JSON file per model — typechecked, never run, not exported from index.ts
src/index.ts             public entry point, re-exports everything above except hashing.ts and downloadTransport.ts
src/testingDoc.test.ts   4 assertions — verifies TESTING.md's test citations are real, so the doc can't rot silently
```

`npm run check` (typecheck + `node --test`) passes: 258 assertions, 0 failures.
`hashing.ts`, `downloadTransport.ts`, and `downloadJournalStore.ts` have no test files and aren't exercised by that count — see "Decisions already made" for why.
`npm run build` emits `dist/` via plain `tsc` (no bundler dependency), and
`npm run check` now runs typecheck + tests + build. The package is still
`private: true` — building is not publishing, and shipping a package that
can't actually load a model would be premature. See open question 3, now
resolved, for what was verified about the build.

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
- **Dev dependencies are `typescript` (7.0.2) and `@types/node` (26.2.0).**
  Direct runtime dependencies remain zero — the first two native modules
  (below) are declared as `peerDependencies`, not bundled dependencies, which
  is the idiomatic shape for an RN library: the consuming app supplies its
  own resolved/linked versions instead of this package pulling in a second
  copy. `.npmrc` sets `omit=peer` so a plain `npm install` in this repo
  doesn't resolve that peer tree — confirmed necessary: a first `npm
  install` without it auto-installed and locked ~7,400 lines of unused
  transitive dependencies into `package-lock.json` for code that doesn't
  exist yet. `--omit=peer` keeps local `node_modules` to just the real
  devDependencies.
- **`expo-file-system` (peer, `^57.0.2`) and `react-native-quick-crypto`
  (peer, `^1.1.6`) were chosen for filesystem I/O and file hashing**,
  2026-08-08, after installing both and reading their actual `.d.ts` files
  rather than trusting secondhand docs/blog posts (docs.expo.dev and
  npmjs.com's package page are both blocked by this environment's egress
  proxy). What was verified, precisely:
  - Stable `expo-file-system@57.0.2` ships a `DownloadTask` class covering
    most of the downloader spec with zero custom native code from this
    project: `pauseAsync()`/`resumeAsync()`/`cancel()`, a progress callback,
    `AbortSignal` cancellation, and — the important one — `savable():
    DownloadPauseState` plus `static fromSavable(state)` to persist a paused
    download and reconstruct it after a JS restart. On iOS,
    `sessionType: 'background'` (the default) is a real background
    `URLSession` that continues while the app is suspended. **On Android the
    same option is explicitly documented as ignored** — no confirmed
    `WorkManager`-equivalent true background continuation. That gap needs
    real-device verification once a toolchain exists; don't assume Android
    parity with iOS here.
  - `File` (which implements `Blob`) has `stream(): ReadableStream<Uint8Array>`
    in the *stable* release — a real chunked read, not a
    whole-file-into-memory one.
  - `File.digest()` — the SHA-256 method — **does not exist in any stable
    release.** It's only in an unpublished canary (`58.0.0-canary-...`),
    which is peer-dependency-locked to a matching canary of the `expo` core
    package itself. Decided not to pin a reliability-focused library to a
    nightly-channel prerelease for this. That's why hashing uses a separate
    library instead of waiting on this.
  - `react-native-quick-crypto`'s `createHash(algorithm).update(chunk)...
    digest('hex')` (its `Hash` class extends Node's `stream.Transform`) is
    the chosen replacement — confirmed via its real `.d.ts`, chainable,
    accepts repeated `update()` calls, matching `File.stream()`'s chunks.
    The design (not yet implemented — see below): pipe `File.stream()`
    chunks into a `Hash`, avoiding a full read into memory for a
    multi-gigabyte model file, without needing the canary `digest()` at all.
  - **Real cost worth naming, not hiding:** `react-native-quick-crypto`
    peer-depends on `react-native-nitro-modules` (Margelo's own JSI codegen
    framework, distinct from Expo Modules). Picking both libraries means
    this project ends up depending on two different native-module
    frameworks side by side — Expo Modules (via `expo-file-system`) and
    Nitro Modules (via `react-native-quick-crypto`). Both are legitimate
    New-Architecture/JSI citizens, but it's a real architectural cost, not a
    free lunch.
  - **`src/hashing.ts` (`computeSha256(file: File): Promise<string>`) is now
    written** — `File.stream()` piped chunk-by-chunk into
    `createHash('sha256').update()`, finalized with `.digest('hex')`. Both
    packages were added as `devDependencies` (in addition to the existing
    `peerDependencies`) so this typechecks against their real, installed
    `.d.ts` — `npx tsc --noEmit` passes. **It has never been run.** Both are
    real native modules that can't be linked or executed without an actual
    RN/Expo app (M0), which doesn't exist here and can't be built in this
    environment. There is deliberately no `hashing.test.ts` — a test that
    can only pass vacuously (or crash importing an unlinked native module
    under plain Node) is worse than no test, per this file's own testing
    rules. Typecheck-only verification is the ceiling until M0 exists.
  - **`hashing.ts` is deliberately not re-exported from `index.ts`.** Every
    other module in the public barrel is pure TypeScript with zero runtime
    dependency; statically importing `hashing.ts` from `index.ts` would make
    the entire public API's import graph require `expo-file-system` and
    `react-native-quick-crypto` to be resolvable, even for a consumer who
    only wants the typed errors or a state machine. `hashing.ts` stays a
    standalone module for now. A proper subpath export (e.g.
    `rn-local-llm/hashing`) is the real fix — see open question 3, the
    `exports` map is still undecided.
  - **The `DownloadTask` adapter (`src/downloadTransport.ts`) is now
    written too**, having initially been deferred as "substantially larger
    unverified surface area" than the hashing wrapper. The judgment calls
    that made it risky are made explicitly, not silently:
    - A `DownloadTask` pause is modeled as `download.ts`'s `interrupted` →
      `failed` transition, since the reducer has no first-class `paused`
      status and a paused-but-resumable transfer is exactly what
      `DownloadInterruptedError` already means there. Resuming a *fresh*
      transport instance (after a JS restart) goes through `start`'s
      `resumeFromBytes`, not `retry` — there's no live reducer left to
      retry from after a process restart, only persisted data.
    - `PersistedDownloadState` bundles `DownloadPauseState` (the opaque,
      platform-specific `resumeData` token) together with `bytesDownloaded`
      tracked separately from the last `progress` event — `savable()`'s
      output alone doesn't carry a byte count, so persisting only the
      pause state and not the byte count would silently lose the number
      `download.ts` needs for `resumeFromBytes`.
    - `downloadAsync()`/`resumeAsync()` resolving `null` means paused;
      since `DownloadTask` only enters `paused` through an explicit pause
      call, that's always a result of this module's own
      `pauseForBackground()`, whose own return value already tells the
      caller what it needs — so that branch deliberately returns a promise
      that never settles rather than manufacturing a fake result.
    - Rejections are re-thrown as this library's own typed errors
      (`DownloadInterruptedError`, or `CancelledError` when the rejection
      followed this module's own `cancel()`), not the raw native rejection
      reason, so a caller `await`ing `result` gets the same typed-error
      contract as everywhere else in this library.
    - Stops at `transferComplete` — checksum verification is deliberately
      left to the caller (`checksum.ts` + `hashing.ts`, run against the
      resolved `File`), the same separation of concerns `download.ts`
      itself already keeps.
    Same verification ceiling as the hashing wrapper: typechecks against
    the real `.d.ts`, has never run, no test file, not exported from
    `index.ts`.
- **The download journal (`downloadJournal.ts`) closes the force-quit gap**,
  built 2026-08-09 — the downloader spec's "survives force-quit mid-download
  and resumes on next launch" was previously false in a way no test caught,
  because the byte offset lived only in memory. Points worth keeping:
  - **No new dependency.** `expo-file-system` was already a peer, and a
    small JSON file per model is the right shape. A key-value store (MMKV,
    AsyncStorage) would have meant a second storage dependency for a few
    hundred bytes per in-flight download.
  - **One file per model, not a shared index.** Two concurrent downloads
    writing one file would race, and a torn write to a shared index loses
    every entry rather than one.
  - **`reconcileJournalEntry()` is where the real logic is**, and it is pure
    and fully tested. Persisting a number is easy; deciding on the next
    launch whether that number can still be trusted is not. It restarts on a
    changed manifest `sha256` (the dangerous case — resuming would build a
    file that can never verify, and you'd only find out after hashing a
    gigabyte), on a missing temp file, on an expired entry, and when nothing
    usable is on disk.
  - **It resumes from the *minimum* of the journal, the actual file size,
    and the manifest total.** The journal is written on a throttle, so after
    a crash the file can hold more than the journal recorded — and those
    extra bytes are the ones most likely to be a torn partial write.
    Re-fetching a few kilobytes beats resuming onto a corrupt tail.
  - **Journal writes are best-effort but not silent.** A failed write never
    aborts a download — losing resumability is much better than failing a
    transfer that is otherwise fine — but it is surfaced through
    `onJournalError` rather than swallowed, per this file's rule against
    swallowing errors to keep a happy path clean.
  - **Writes are throttled** (8 MiB or 5 s by default, both configurable).
    Bytes-only never persists on a stalled-but-alive connection; time-only
    writes constantly on a fast one.
  - `ExpoDownloadJournalStore` is the usual unverified adapter: typechecks
    against the real `.d.ts`, has never run, no test file, reachable at
    `rn-local-llm/journal-store`.
- **`TESTING.md` records all eight field conditions**, added 2026-08-09,
  satisfying the Testing section's "every one of them must have a test or a
  documented manual procedure." For each: what is genuinely covered today
  (citing test names), what that coverage explicitly does *not* prove, the
  device procedure, and pass criteria. Two things it surfaced that are worth
  knowing without reading it: **conditions 4 and 7 have no procedure at
  all** because generation doesn't exist, so writing one would be fiction.
  (It originally flagged condition 3 as failing for an implementation
  reason rather than a testing one; the download journal has since closed
  that, and the section is updated.)
- **`TESTING.md`'s citations are machine-checked** by
  `src/testingDoc.test.ts`. A document whose value is "here is the evidence"
  is worthless once a test is renamed underneath it, and this repo's whole
  posture is that an unverified guarantee is a liability dressed as a
  feature. The checker was confirmed working by renaming a cited test and
  watching it fail. It also asserts the citation count is non-trivial, so a
  parser that silently matches nothing can't make the suite pass vacuously.
- **The build is plain `tsc`, not a bundler**, decided 2026-08-09. A
  bundler (tsup, unbuild, react-native-builder-bob) would be a new
  devDependency earning nothing here: this package is TypeScript that
  Metro bundles anyway, and there is no CSS, no asset pipeline, and
  nothing to tree-shake that `sideEffects: false` doesn't already cover.
  `tsconfig.build.json` extends the dev config, flips `noEmit` off, emits
  declarations, and excludes `**/*.test.ts`.
- **`rewriteRelativeImportExtensions` is what makes the `.ts`-specifier
  convention survive the build.** `src/` must import with literal `.ts`
  extensions (Node's type stripping demands it — see the environment
  section). That flag rewrites them to `.js` in emitted JavaScript, which
  is what has to resolve at runtime. Emitted `.d.ts` files keep the `.ts`
  specifier; that looked wrong, so it was checked rather than assumed —
  a real consumer typechecks against it fine, because TypeScript resolves
  a `.ts` specifier in a declaration file to the sibling `.d.ts`.
- **The `exports` map has three entries, and the split is the point.**
  `.` is the pure-TypeScript barrel; `./hashing` and
  `./download-transport` are the two modules that need native peers. This
  is what finally lets those two be reachable *without* forcing
  `expo-file-system` and `react-native-quick-crypto` on someone who only
  wants the typed errors or a state machine — the problem that previously
  left them orphaned from `index.ts`. Verified end-to-end against a packed
  tarball installed into a clean project with no native deps: the barrel
  imports and runs, both subpaths fail with `ERR_MODULE_NOT_FOUND` (the
  peer is genuinely absent, exactly as intended), and a deep import like
  `rn-local-llm/dist/errors.js` is blocked with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **Verified the discriminated union survives the build.** A TypeScript
  consumer of the packed tarball can write an exhaustive `switch` over all
  eight error kinds with no `default`, and deleting one case fails that
  consumer's build. Types crossing a package boundary is exactly the kind
  of thing that silently degrades, so it was broken on purpose to confirm.
- **`npm run check` now runs typecheck + tests + build**, so a change that
  compiles under `--noEmit` but breaks real emit can't pass unnoticed.
- **No source maps or declaration maps are emitted.** They'd require
  shipping `src/` to be useful, and this library will be installed by
  people who care about package size. Cheap to revisit if debugging into
  the library ever gets painful.
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
- **The downloader's transport was not built.** "True background transfer" is
  a native requirement (`URLSession` background config, `WorkManager`) —
  there is no TS-only version of this that would be real rather than a stub,
  and this file's own working style says a working slice beats a stubbed one.
- **The download state machine (`download.ts`) is built, and its retry
  semantics are the part worth remembering:** a transport interruption
  (`DownloadInterrupted`) resumes on retry from `bytesDownloaded`, because
  the bytes already on disk are still good; a checksum mismatch
  (`ChecksumMismatch`) restarts from `0` on retry, because the bytes on disk
  are exactly the ones that failed verification — resuming would just
  re-verify the same bad data. `download.test.ts` has an end-to-end test
  covering both paths in sequence. The reducer also enforces monotonic
  progress, rejects `transferComplete` before all bytes arrive, and rejects
  any event that doesn't apply to the current status via
  `InvalidDownloadTransitionError` (a caller-bug class, not part of
  `LocalLlmErrorKind` — same reasoning as `ManifestValidationError`). It owns
  no I/O, no persistence, and no transport; a host layer will need to persist
  `bytesDownloaded` somewhere durable and pass it back in as `start`'s
  `resumeFromBytes` after a force-quit — this reducer only proves the shape
  of that resume is correct, it doesn't implement the persisting.
- **The orchestrator (`downloadModel.ts`) takes its transport, hasher, and
  filesystem as injected ports** (`ModelTransfer`, `FileHasher`,
  `ModelFileStore`). This is the design decision that matters most in this
  file: it means the orchestration logic — retry semantics, cancellation,
  temp-file cleanup, the ordering guarantee that nothing reaches the
  destination before it verifies — is covered by 31 real assertions
  running against fakes on a machine with no device. It converts what
  would otherwise have been a third typecheck-only module into genuinely
  tested logic plus one thin unverified adapter. Prefer this shape for
  anything else that touches the outside world.
- **Guarantees `downloadModel.ts` holds, each with a test:** nothing
  reaches `destinationPath` until its SHA-256 matches the manifest; a
  checksum failure deletes the temp file *before* retrying (so a retry can
  never re-verify the same bad bytes, which is what makes `download.ts`'s
  restart-from-zero honest); a transport failure leaves the temp file
  alone so the retry resumes; the move happens while still `verifying`, so
  a failed move lands in `failed` rather than a `complete` that lied.
- **The free-disk precheck runs once, before the state machine starts, and
  is never retried.** Running it before `start` means a refusal leaves no
  download state to report and nothing on disk to clean up — which is the
  whole reason it needed its own error kind rather than reusing
  `DownloadInterrupted`. It is not re-run per attempt (retrying cannot
  create space, and a second check would just re-fail), and it reserves
  only the bytes *still to be written*, so a resumed download doesn't
  demand room for bytes already on disk. It assumes temp and destination
  share a filesystem so the final move is a rename; if a host ever splits
  them across volumes, the check would need roughly double.
- **Cancellation does not trust the transport.** `downloadModel()` races
  every await against its own cancellation signal rather than just
  awaiting the transport's promise. Locked decision #5 says everything
  async is cancellable with no exceptions — awaiting the transport alone
  would make that only as strong as the transport's manners, and a
  transport that never settles after `cancel()` would hang forever. There
  is a test (`cancels even a transport that never settles after cancel()`)
  using a deliberately badly-behaved fake; it caught this exact bug during
  development, when the signal existed but was never fired.
- **`cancel()` is not gated on the reducer's status.** Adding the async
  disk precheck opened a window where the reducer is still `idle` when a
  caller cancels — and an earlier version, which returned early unless the
  status was `downloading`/`verifying`, silently dropped cancels issued in
  that window. `cancel()` now always records the cancellation and fires
  the signal, and only *dispatches* to the reducer when the reducer can
  accept it. `runAttempt()` also re-checks before calling
  `transfer.start()`, because starting a transfer after cancellation would
  leak it — `cancel()` has already run and had no handle to forward to.
  Both paths have tests; both were real bugs, not hypotheticals.
- **Cancelling leaves the partial temp file on disk.** Deleting it would
  make an explicit cancel unresumable, which is the opposite of what this
  library is for on a 1.2 GB download over mobile data. Reclaiming temp
  files is the host's job. Only a *checksum failure* deletes, because
  those specific bytes are known bad.
- **`maxAttempts` defaults to 3.** A single network blip should not kill a
  twenty-minute download, and the reducer already makes retries safe
  (resume after interruption, restart after checksum failure). Worth
  revisiting if it ever masks a genuinely stale manifest hash — three
  full re-downloads of a large file is not free.
- **`downloadTransport.ts` was rewritten to be dumb.** Its first draft
  drove `download.ts`'s reducer itself; once the orchestrator existed that
  made two separate owners of one state machine. It is now just
  `ExpoModelTransfer implements ModelTransfer` — bytes on disk plus
  progress callbacks, nothing else. Smaller, and less unverified logic,
  which is the direction to keep pushing.
- **The global load lock (`loadLock.ts`) enforces locked decision #4 as a
  state machine: idle → loading → loaded, one model id at a time.** Loading
  a second model *displaces* whatever was loading or resident — it is never
  queued. `transitionLoadLock()` returns `{ state, modelToUnload? }`:
  `modelToUnload` is set whenever a transition means a previously
  loading/resident model must be natively unloaded, so the host driving this
  reducer knows exactly when to issue that native call and, if the displaced
  model was still loading, to reject its pending load promise with `new
  CancelledError('load')`. `loadLock.test.ts` has a test named for the exact
  scenario CLAUDE.md's Testing section calls out: "second model requested
  while the first is loading." `unload` only applies from `loaded` —
  cancelling a load in progress goes through `cancel` instead, on the
  reasoning that tearing down a half-finished native load is a different
  operation from tearing down a fully resident one. Like the other
  reducers, this one holds no native memory and does no I/O; it only tracks
  which model id *should* be resident.

## Adding an error kind

It is a breaking change for consumers that switch exhaustively. Four edits:

1. Add the string to `LocalLlmErrorKind` in `errors.ts`.
2. Add a class extending `LocalLlmErrorBase<'YourKind'>`, with typed fields,
   a message carrying the numbers a developer needs, and TSDoc stating when
   it is raised and what recovery exists.
3. Add it to the `LocalLlmError` union.
4. Add a sample to `SAMPLES` in `errors.test.ts`.

Steps 1 and 3 without 2 and 4 will fail the build. That is intended, and it
was confirmed working when `InsufficientDiskSpace` was added on 2026-08-09:
doing edits 1–3 and running `tsc` produced exactly the expected
`SAMPLES`-missing-property error, which edit 4 then cleared.

Also update the kind list in the "Engineering rules" section above — it
enumerates the union by hand and will otherwise go stale.

## Open questions — decide before building

1. ~~Can the ops-layer TypeScript run ahead of M0?~~ **Resolved 2026-08-08:
   yes**, explicitly, given this environment's lack of a device. See
   "Decisions already made" above.
2. **Rename before publish.** Still unresolved — user chose to keep
   `rn-local-llm` for now (decided 2026-08-08) and revisit before publishing.
3. ~~No build yet.~~ **Resolved 2026-08-09: plain `tsc` emit to `dist/`,
   with a three-entry `exports` map** (`.`, `./hashing`,
   `./download-transport`). See "Decisions already made" above for what was
   verified against a real packed tarball. The package is deliberately
   still `private: true` — it builds and can be consumed locally (via a
   `file:` reference, which runs the `prepare` script), but publishing it
   would ship something that cannot actually load a model until M0/M1
   exist. Flipping `private` is a separate decision, gated on the rename
   (question 2) and on there being native code worth shipping.
   **One thing genuinely untested:** the emitted output is ESM-only, and
   nothing has run it through Metro. Modern React Native (New
   Architecture, which is locked decision #1) supports `exports` and ESM,
   so this should be fine, but "should be" is not "verified" — the example
   app at M0 is where it gets proven, and a CJS fallback is the fix if it
   turns out to be needed.
4. ~~Crypto/hashing dependency for on-device SHA-256.~~ **Resolved
   2026-08-08: `react-native-quick-crypto`**, paired with `expo-file-system`'s
   `File.stream()` for chunked reads (avoiding `File.digest()`, which is
   canary-only). See "Decisions already made" above for the verified API
   details and the Nitro-Modules-vs-Expo-Modules cost. `src/hashing.ts` is
   written and typechecks against both packages' real, installed `.d.ts` —
   but has never been run. Verifying it actually works needs a real RN/Expo
   app (M0), which this environment can't build.
5. **Download transport, mostly resolved but not fully.** `expo-file-system`'s
   stable `DownloadTask` (see "Decisions already made") covers pause/resume,
   progress, cancellation, cross-restart persistence via
   `savable()`/`fromSavable()`, and confirmed real iOS background transfer.
   `src/downloadTransport.ts` wraps it as `ExpoModelTransfer`, satisfying
   `downloadModel.ts`'s `ModelTransfer` port — typechecked, never run, same
   M0 ceiling as `hashing.ts`. The orchestration above it now exists and is
   tested (see `downloadModel.ts`).
   **Still genuinely open:** Android's background-continuation behavior is
   undocumented/unconfirmed (the `sessionType` option is explicitly ignored
   there) — needs verification on a real Android device once a toolchain
   exists, and may still need a supplementary approach (e.g. a foreground
   service, or accepting that an Android transfer pauses when the app is
   fully backgrounded rather than continuing) if it turns out not to
   survive backgrounding the way iOS does.
6. ~~The free-disk precheck needs an eighth error kind.~~ **Resolved
   2026-08-09: `InsufficientDiskSpace` was added**, by explicit decision,
   following the four-edit procedure above. `DownloadInterrupted` would
   have been semantically wrong — nothing is interrupted when the download
   never started. `diskGuard.ts`'s `checkDiskCapacity()` holds the
   decision logic (mirroring `memoryGuard.ts`), and `downloadModel()` runs
   it once before the first byte is requested. Reading actual free space
   is native, so it arrives through the `ModelFileStore.freeDiskBytes()`
   port. A disk-space failure is deliberately **not** retried — retrying
   cannot create space.
7. **Wi-Fi-only mode (default) with cellular opt-in isn't built.** It needs
   a network-state source, which is another native dependency decision
   (`@react-native-community/netinfo` or equivalent) that hasn't been
   asked about. The policy itself would be pure, testable logic once a
   source exists.
