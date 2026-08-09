# rn-local-llm

Working name. Rename before first publish — see `CLAUDE.md`.

A React Native library for running a small language model **on the device**,
offline. Inference itself (ExecuTorch, llama.cpp) is a solved problem; this
library is the operations layer around it — getting the model file onto the
phone, keeping it there, versioning it, and not crashing a low-memory Android
device mid-generation.

```ts
const model = useLocalModel('qwen3-1.7b-q4');
const reply = await model.generate('Summarize this note: ...');
```

That API is the target shape, not something you can install yet — see
**Status** below.

## Status

Early and not installable as a package. No native code exists, so no model
can actually be loaded or run yet. What's implemented so far is pure
TypeScript: the typed error union, the model manifest schema and validation,
the model registry, the memory guard's preflight decision logic, the
download state machine's orchestration/retry logic (not its transport), and
the global load lock that enforces one model resident at a time, the
free-disk preflight check, the download orchestrator that sequences
precheck → transfer → hash → checksum → atomic move (its I/O is injected,
so its retry, cancellation, and cleanup logic is genuinely tested against
fakes), and the journal that lets an interrupted download resume after the
app is killed rather than starting over.

The two adapters that touch real native modules — SHA-256 hashing and the
download transport — typecheck against their real dependencies but have
never been executed, because that needs a device this project doesn't have
yet. No model has ever actually been downloaded, loaded, or run.

For what's built, what isn't, and why, see the "Current state" section of
[`CLAUDE.md`](./CLAUDE.md) — kept up to date as the source of truth.
[`TESTING.md`](./TESTING.md) covers the eight real-world failure conditions
this library exists to survive: what's actually tested today, what that
testing does *not* prove, and the device procedure for each.

## Development

```sh
npm install
npm run check   # typecheck + tests + build
npm run build   # emit dist/ on its own
```

Requires Node >= 22.18.

The package builds with plain `tsc` (no bundler) and exposes three entry
points. The main one is pure TypeScript with no native dependencies; the
other two are separated precisely so that stays true:

```ts
import { downloadModel, ModelRegistry } from 'rn-local-llm';
import { computeSha256 } from 'rn-local-llm/hashing';                    // needs native peers
import { ExpoModelTransfer } from 'rn-local-llm/download-transport';     // needs native peers
import { ExpoDownloadJournalStore } from 'rn-local-llm/journal-store';   // needs native peers
```

Not published yet — see **Status**.

## License

MIT — see [`LICENSE`](./LICENSE).
