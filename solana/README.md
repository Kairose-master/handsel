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

## Before the first deploy

`declare_id!` currently holds a **placeholder nobody has the private key for**
(derived from a hash so it is a valid address and obviously not a real one).
Deploying needs a keypair whose pubkey matches it, so the first deploy is a
three-step ritual:

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
