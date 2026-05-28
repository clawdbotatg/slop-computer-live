"use client";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppProgressBar as ProgressBar } from "next-nprogress-bar";
import { Toaster } from "react-hot-toast";
import { WagmiProvider } from "wagmi";
import { UpgradeModal } from "~~/components/UpgradeModal";
import { BlockieAvatar } from "~~/components/scaffold-eth";
import { wagmiConfig } from "~~/services/web3/wagmiConfig";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

export const ScaffoldEthAppWithProviders = ({ children }: { children: React.ReactNode }) => {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ProgressBar height="3px" color="#cc2b2b" />
        <RainbowKitProvider avatar={BlockieAvatar} theme={darkTheme()}>
          {children}
          <Toaster />
          <UpgradeModal />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
};
