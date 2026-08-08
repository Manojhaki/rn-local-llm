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
| M0 — Skeleton | **Not started.** No native code exists. `/ios`, `/android`, `/cpp`, `/example`, `/benchmarks` do not exist. |
| M1–M4 | Not started. |
| Cross-cutting | Typed error union: **not started.** |

## What exists

```
README.md            one line: "# rn-local-llm"
```

Nothing else is in the repo yet: no `CLAUDE.md` (until this commit), no
`package.json`, no `tsconfig.json`, no `LICENSE`, no `src/` directory, no
tests, no build. There is no entry point and nothing to `npm install`.

## Verify your environment before planning work

There is no `npm run check` yet — no `package.json` exists to define it. Once
one is added, re-establish what this environment can actually verify:

```
xcodebuild -version      # iOS builds
sdkmanager --list        # Android builds
adb devices               # physical hardware
```

**If those are missing, you cannot complete M0, or any milestone.** Definition
of done items 1 and 2 are unverifiable without them. Say so plainly rather than
writing native code blind and calling it done.

## Decisions already made — do not silently revisit

None yet beyond what's captured in the "Locked architecture decisions" and
"Engineering rules" sections above. No code has been written, so no
implementation-level decisions (error class design, license choice, dev
dependency list) have been made in practice — those will need to be decided
when the corresponding work starts.

## Open questions — decide before building

1. **Can the ops-layer TypeScript run ahead of M0?** The manifest schema,
   checksum verification, and download state machine are fully testable with no
   device, but they are M2, and this brief forbids starting a milestone before
   the previous one passes on hardware. If your environment has no device, that
   rule blocks all remaining work. Resolve it explicitly rather than drifting
   past it.
2. **Rename before publish.** `rn-local-llm` is a working name and appears in
   the directory name and the README heading.
3. **No entry point or build.** Nothing exists yet — package manifest, strict
   TypeScript config, `exports` map, and build tooling all need to be decided
   before any code is written.
