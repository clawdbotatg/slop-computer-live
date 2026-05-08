"use client";

import { useCallback, useEffect, useState } from "react";

export type MediaDeviceList = {
  mics: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  /** Force a re-enumerate. Call this after a getUserMedia resolves so the
   *  list picks up labels that only become available post-permission —
   *  Chrome doesn't always fire `devicechange` for that case. */
  refresh: () => void;
};

// Lightweight reactive list of input devices (mic + camera). Re-enumerates
// when the OS reports a `devicechange` (plug/unplug, BT pairing, virtual
// device added). Note: device .label is empty until the user has granted
// at least one getUserMedia for that kind — the consumer should fall back
// to a generic name in that case AND call refresh() once permission lands.
export function useMediaDevices(): MediaDeviceList {
  const [devices, setDevices] = useState<{ mics: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }>({
    mics: [],
    cameras: [],
  });

  const enumerate = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        mics: all.filter(d => d.kind === "audioinput"),
        cameras: all.filter(d => d.kind === "videoinput"),
      });
    } catch {
      /* permission policy / not supported */
    }
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    void enumerate();
    navigator.mediaDevices.addEventListener("devicechange", enumerate);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", enumerate);
    };
  }, [enumerate]);

  return { ...devices, refresh: enumerate };
}
