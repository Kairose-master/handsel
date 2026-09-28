import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { pool } from '@/lib/db'
import type { X402Network } from '@/lib/x402-network'

type WalletRow = { address: string; encrypted_key: string; network: string }

function encryptionKey(): Buffer | null {
  const value = process.env.X402_WALLET_ENCRYPTION_KEY?.trim()
  if (!value) return null
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value.replace(/^0x/, ''), 'hex')
  try {
    const decoded = Buffer.from(value, 'base64')
    return decoded.length === 32 ? decoded : null
  } catch {
    return null
  }
}

function seal(secret: `0x${string}`, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

function unseal(value: string, key: Buffer): `0x${string}` {
  const [ivText, tagText, cipherText] = value.split('.')
  if (!ivText || !tagText || !cipherText) throw new Error('Stored x402 signer material is malformed')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return `0x${Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8')}`
}

async function ensureTable(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_x402_wallet (
    agent_id text PRIMARY KEY,
    address text NOT NULL UNIQUE,
    encrypted_key text NOT NULL,
    network text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`)
}

/** Keys are encrypted at rest; the only public field exposed is the funding address. */
export async function x402WalletFor(agentId: string): Promise<{ address: string; network: X402Network } | null> {
  await ensureTable()
  const { rows } = await pool.query<WalletRow>(
    'SELECT address, encrypted_key, network FROM agent_x402_wallet WHERE agent_id = $1',
    [agentId],
  )
  const row = rows[0]
  return row ? { address: row.address, network: row.network as X402Network } : null
}

export async function ensureX402Wallet(agentId: string, network: X402Network): Promise<{ address: string; network: X402Network }> {
  const key = encryptionKey()
  if (!key) throw new Error('Per-agent x402 wallets are disabled: set X402_WALLET_ENCRYPTION_KEY to a random 32-byte key.')
  await ensureTable()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`x402-wallet:${agentId}`])
    const { rows } = await client.query<WalletRow>(
      'SELECT address, encrypted_key, network FROM agent_x402_wallet WHERE agent_id = $1 FOR UPDATE',
      [agentId],
    )
    if (rows[0]) {
      if (rows[0].network !== network) throw new Error('This agent wallet is on a different x402 network; it cannot be silently replaced.')
      // Verify that the configured key can still decrypt the stored wallet before exposing it.
      unseal(rows[0].encrypted_key, key)
      await client.query('COMMIT')
      return { address: rows[0].address, network }
    }
    const secret = generatePrivateKey()
    const address = privateKeyToAccount(secret).address
    await client.query(
      'INSERT INTO agent_x402_wallet (agent_id, address, encrypted_key, network) VALUES ($1, $2, $3, $4)',
      [agentId, address, seal(secret, key), network],
    )
    await client.query('COMMIT')
    return { address, network }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function x402SignerKeyFor(agentId: string, network: X402Network): Promise<`0x${string}`> {
  const key = encryptionKey()
  if (!key) throw new Error('Per-agent x402 signing is not configured on this deployment.')
  await ensureTable()
  const { rows } = await pool.query<WalletRow>(
    'SELECT address, encrypted_key, network FROM agent_x402_wallet WHERE agent_id = $1',
    [agentId],
  )
  const row = rows[0]
  if (!row) throw new Error('This agent has no x402 wallet. Connect a paid tool again to provision one.')
  if (row.network !== network) throw new Error('The agent x402 wallet network does not match this deployment.')
  const secret = unseal(row.encrypted_key, key)
  if (privateKeyToAccount(secret).address.toLowerCase() !== row.address.toLowerCase()) {
    throw new Error('Stored x402 signer does not match its registered payer address.')
  }
  return secret
}

export function x402WalletEncryptionConfigured(): boolean {
  return encryptionKey() !== null
}
