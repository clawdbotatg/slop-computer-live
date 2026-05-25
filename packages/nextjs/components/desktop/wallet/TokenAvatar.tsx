"use client";

import { useState } from "react";

// Token icon (round) with a small chain badge in the bottom-right.
// Falls back to a magenta-tinted monogram tile if no thumbnail is
// available or the image 404s. Used by:
//   - The Assets tab row + asset detail modal (WalletAssetsPanel)
//   - The AI tx summary card's input/output chips (WalletWindow)
// Kept in its own module so both surfaces render identical tokens.

const ACCENT = "var(--slop-magenta, #ff3ec9)";

// llamao chain logos — same source the AI wallet UI uses. Keys match
// the Zerion chain slug emitted on PortfolioAsset.blockchain and on
// each TxSummaryAsset.chain from the wallet-ai summarizer.
export const CHAIN_ICONS: Record<string, string> = {
  ethereum: "https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg",
  base: "https://icons.llamao.fi/icons/chains/rsz_base.jpg",
  arbitrum: "https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg",
  optimism: "https://icons.llamao.fi/icons/chains/rsz_optimism.jpg",
  polygon: "https://icons.llamao.fi/icons/chains/rsz_polygon.jpg",
  xdai: "https://icons.llamao.fi/icons/chains/rsz_xdai.jpg",
  gnosis: "https://icons.llamao.fi/icons/chains/rsz_xdai.jpg",
  linea: "https://icons.llamao.fi/icons/chains/rsz_linea.jpg",
  scroll: "https://icons.llamao.fi/icons/chains/rsz_scroll.jpg",
  "zksync-era": "https://icons.llamao.fi/icons/chains/rsz_zksync%20era.jpg",
  zksync: "https://icons.llamao.fi/icons/chains/rsz_zksync%20era.jpg",
  mantle: "https://icons.llamao.fi/icons/chains/rsz_mantle.jpg",
  zora: "https://icons.llamao.fi/icons/chains/rsz_zora.jpg",
  unichain: "https://icons.llamao.fi/icons/chains/rsz_unichain.jpg",
  "binance-smart-chain": "https://icons.llamao.fi/icons/chains/rsz_binance.jpg",
  avalanche: "https://icons.llamao.fi/icons/chains/rsz_avalanche.jpg",
};

export type TokenAvatarProps = {
  symbol: string;
  thumbnail?: string | null;
  chain?: string | null;
  size?: number;
};

export const TokenAvatar = ({ symbol, thumbnail, chain, size = 28 }: TokenAvatarProps) => {
  const [imgFailed, setImgFailed] = useState(false);
  const chainIcon = chain ? CHAIN_ICONS[chain.toLowerCase()] : null;
  const badgeSize = Math.max(10, Math.round(size * 0.42));
  return (
    <span
      style={{
        position: "relative",
        flexShrink: 0,
        width: size,
        height: size,
        display: "inline-block",
      }}
    >
      {thumbnail && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnail}
          alt={symbol}
          width={size}
          height={size}
          onError={() => setImgFailed(true)}
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.05)",
            display: "block",
          }}
        />
      ) : (
        <span
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: "rgba(255,62,201,0.14)",
            border: "1px solid rgba(255,62,201,0.4)",
            color: ACCENT,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--slop-font-display)",
            fontSize: Math.max(9, Math.round(size * 0.38)),
            letterSpacing: 0,
          }}
        >
          {symbol.slice(0, 2).toUpperCase()}
        </span>
      )}
      {chainIcon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={chainIcon}
          alt={chain ?? ""}
          width={badgeSize}
          height={badgeSize}
          style={{
            position: "absolute",
            bottom: -2,
            right: -2,
            width: badgeSize,
            height: badgeSize,
            borderRadius: "50%",
            boxShadow: "0 0 0 2px #06030d",
            background: "#06030d",
          }}
        />
      ) : null}
    </span>
  );
};

export default TokenAvatar;
