# handsel-market — Solana devnet

The escrow money loop as an Anchor program. **Devnet only** — that is a
decision, with its reasoning, in [`../docs/solana-port.md`](../docs/solana-port.md).
Read that before touching anything here.

```
programs/handsel-market/src/lib.rs   the program
scripts/happy-path.ts                post → accept → submit → approve → withdraw,
                                     with the arithmetic asserted at each step
```

## Gates

| Command | Proves |
|---|---|
| `cargo check` | The program type-checks. This is the in-repo gate (CLAUDE.md). |
| `anchor build` | It links as an SBF object and produces an IDL. Needs `cargo-build-sbf`, so it runs in CI. |
| `npx tsc --noEmit` | The client scripts agree with the generated IDL types. Needs `anchor build` first. |
| `npx tsx scripts/happy-path.ts` | The escrow actually adds up, on a live cluster. |

`cargo check` passing does **not** mean the program deploys: it uses the host
target, so it cannot see a stack-frame overflow or a missing `idl-build`
feature. `.github/workflows/solana-devnet.yml` is where the real compile happens.

## The SBF toolchain runs an OLD rustc

`cargo-build-sbf` bundles its own Rust — 1.79 at the time of writing — while
your host has something far newer. So `cargo` resolves the lockfile to the
newest compatible version of every dependency, and then the SBF toolchain
fails to parse a manifest wanting an edition it has never heard of. It is not
your code; it is the resolver optimising for a compiler that is not the one
doing the build.

```bash
node scripts/check-msrv.mjs                 # every locked crate vs rustc 1.79
node scripts/check-msrv.mjs --msrv 1.85.0   # after a toolchain upgrade
```

Run it after **any** `cargo update`. It is also a CI step, before `anchor
build`, because the build itself reports one offender per run and the first
time this happened there were sixteen.

**Fixing a failure.** Re-resolve rather than pinning one crate at a time:

```bash
# in solana/Cargo.toml, temporarily: resolver = "2"  ->  resolver = "3"
cargo update
# put it back to "2" — resolver 3 is MSRV-aware, but the SBF toolchain's cargo
# is too old to READ a resolver-3 manifest. The LOCKFILE is what CI consumes.
node scripts/check-msrv.mjs
```

That fixes anything whose own `rust-version` is too high. It does **not** fix a
crate dragged in by a dependency's semver requirement — resolver 3 reads a
crate's own MSRV, not its dependencies'. Those need a targeted pin on the
PARENT: `blake3 1.8.3` was fine itself while requiring `constant_time_eq ^0.4`,
all of which need 1.85, so the fix was `cargo update -p blake3 --precise 1.8.2`
and eight crates followed it down.

## Before the first deploy

The program id is `8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H` and its
keypair exists — the private half belongs in the `SOLANA_PROGRAM_KEYPAIR` repo
secret and nowhere else. If you ever need to mint a NEW one (a fresh program,
or a lost key), that is this ritual:

```bash
node scripts/keygen.mjs /tmp/handsel-program.json   # keep this OUT of the repo
# it prints the address — that is the real program id
# put that id in declare_id! and commit
# put the file's CONTENTS in the SOLANA_PROGRAM_KEYPAIR repo secret, then delete it
```

**Do not run `npx solana-keygen`.** The official Solana CLI is not published to
npm; that command fetches an unrelated third-party package of the same name,
and a key generator is the worst possible thing to run from an unvetted source.
`scripts/keygen.mjs` uses only `node:crypto`, needs no toolchain, and is
verified by `tests/solana-keygen.test.ts` — which checks the stored seed
actually derives the stored public key and that a signature made with it
verifies, rather than trusting that 64 bytes look like a keypair.

If you would rather use the real CLI, install it from Anza (never from npm)
and `solana-keygen new -o …` works the same way:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
```

The workflow verifies the match and fails with this instruction rather than
deploying to one address while every client derives PDAs against another —
which fails at runtime, far from the cause.

Also needed as a secret: `SOLANA_DEPLOYER_KEYPAIR`, a funded devnet wallet
(~3 SOL covers the program's rent-exempt storage plus the script's accounts).

Then: **Actions → Solana devnet → Run workflow**, with `deploy` and
`run_happy_path` checked.
