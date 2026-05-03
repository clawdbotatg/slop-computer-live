"use client";

import Link from "next/link";
import type { NextPage } from "next";
import { Bevel, Button, LivePulse, MenuBar } from "~~/components/ui";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const HLS_URL = process.env.NEXT_PUBLIC_HLS_URL ?? "";

const Home: NextPage = () => {
  const { data: isLive } = useScaffoldReadContract({
    contractName: "SlopComputerFrontpage",
    functionName: "isLive",
  });

  const { data: currentTitle } = useScaffoldReadContract({
    contractName: "SlopComputerFrontpage",
    functionName: "currentTitle",
  });

  const live = Boolean(isLive);

  return (
    <>
      <MenuBar isLive={live} />
      <main
        style={{
          minHeight: "100vh",
          paddingTop: 60,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
          color: "var(--slop-text)",
        }}
      >
        <Bevel style={{ padding: 24, width: "min(720px, 92vw)" }}>
          <h1
            style={{
              fontFamily: "var(--slop-font-display)",
              fontSize: 28,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              margin: 0,
            }}
          >
            <LivePulse live={live} size={14} /> {live ? "the show is live now" : "next show TBA"}
          </h1>

          {live && currentTitle ? (
            <p style={{ color: "var(--slop-text-muted)", marginTop: 8 }}>
              Now playing: <strong style={{ color: "var(--slop-text)" }}>{currentTitle}</strong>
            </p>
          ) : null}

          {live ? (
            <div style={{ marginTop: 16 }}>
              {HLS_URL ? (
                <video
                  controls
                  autoPlay
                  muted
                  playsInline
                  style={{
                    width: "100%",
                    background: "#000",
                    aspectRatio: "16 / 9",
                    border: "1px solid var(--slop-bevel-dark)",
                  }}
                  src={HLS_URL}
                />
              ) : (
                <div style={{ color: "var(--slop-text-muted)" }}>No HLS URL configured. Set NEXT_PUBLIC_HLS_URL.</div>
              )}
            </div>
          ) : (
            <p style={{ color: "var(--slop-text-muted)", marginTop: 12 }}>
              Follow the show at{" "}
              <a href="https://slop.computer" style={{ color: "var(--slop-accent)" }}>
                slop.computer
              </a>
              .
            </p>
          )}

          <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
            <Link href="/desktop">
              <Button>Open Desktop</Button>
            </Link>
            <Link href="/admin">
              <Button>Admin</Button>
            </Link>
            <Link href="/join">
              <Button variant="primary">Join via invite</Button>
            </Link>
          </div>
        </Bevel>
      </main>
    </>
  );
};

export default Home;
