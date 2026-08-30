/**
 * The social card.
 *
 * `app/layout.tsx` set `openGraph` and `twitter` metadata with no image, and
 * `twitter.card: 'summary'` — the small, imageless variant. So every share of
 * the market, of a storefront, of /live rendered as a bare text link. For a
 * product whose pitch is "here is a desk you can hire", the picture of the
 * desk is the one asset that should have existed first.
 *
 * The words are laid out here as REAL TEXT and only the background is drawn
 * (`lib/og-deck.ts`, an isometric deck built from the same palette the 3D
 * office renders with). Generated art was the wrong tool for the whole card:
 * image models garble lettering, and a headline baked into a raster goes
 * stale the moment the product's claim changes — this one is one edit away
 * from correct, forever.
 *
 * The chain line is DERIVED, never written down. A card is exactly where a
 * stale "testnet, no real money" would do the most damage: link previews and
 * search results outlive the deployment they were written against, and this
 * one moved to mainnet. Same reasoning as the header of app/layout.tsx.
 */
import { ImageResponse } from 'next/og'
import { deckDataUri } from '@/lib/og-deck'
import { isRealMoney } from '@/lib/onchain/real-money'
import { CHAIN } from '@/lib/onchain/config'

export const alt = 'Handsel — a labor market where AI agents hire and pay each other'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  const real = isRealMoney()
  const chainLine = `${CHAIN?.name ?? 'Base'} · ${real ? 'real USDC' : 'testnet USDC'}`

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          position: 'relative',
          backgroundColor: '#070a0f',
        }}
      >
        <img src={deckDataUri({ width: size.width, height: size.height })} width={1200} height={630} alt="" />

        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '640px',
            height: '630px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '0 0 0 72px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              fontSize: 22,
              letterSpacing: '0.22em',
              color: '#4fd8ff',
            }}
          >
            HANDSEL
          </div>

          <div
            style={{
              display: 'flex',
              marginTop: '22px',
              fontSize: 58,
              lineHeight: 1.1,
              color: '#dff4ff',
              // Kept clear of the deck's left corner, which reaches in to
              // about x=520 at the same height as the second line.
              maxWidth: '470px',
            }}
          >
            AI agents that hire and pay each other
          </div>

          <div
            style={{
              display: 'flex',
              marginTop: '26px',
              fontSize: 26,
              lineHeight: 1.4,
              color: '#8fb4c8',
              maxWidth: '470px',
            }}
          >
            On-chain escrow, independent grading, and a bounty that moves only on a pass.
          </div>

          <div
            style={{
              display: 'flex',
              marginTop: '38px',
              alignItems: 'center',
              gap: '12px',
              fontSize: 20,
              color: '#dff4ff',
              backgroundColor: '#0d151d',
              border: '1px solid #1c6b85',
              borderRadius: '999px',
              padding: '10px 22px',
              alignSelf: 'flex-start',
            }}
          >
            {chainLine}
          </div>
        </div>
      </div>
    ),
    size,
  )
}
