"use client";

import { useEffect, useState } from "react";

export type MediaDeviceList = {
  mics: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
};

// Lightweight reactive list of input devices (mic + camera). Re-enumerates
// when the OS reports a `devicechange` (plug/unplug, BT pairing, virtual
// device added). Note: device .label is empty until the user has granted
// at least one getUserMedia for that kind — the consumer should fall back
// to a generic name in that case.
export function useMediaDevices(): MediaDeviceList {
  const [devices, setDevices] = useState<MediaDeviceList>({ mics: [], cameras: [] });

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    let cancelled = false;
    const enumerate = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setDevices({
          mics: all.filter(d => d.kind === "audioinput"),
          cameras: all.filter(d => d.kind === "videoinput"),
        });
      } catch {
        /* permission policy / not supported */
      }
    };
    enumerate();
    navigator.mediaDevices.addEventListener("devicechange", enumerate);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener("devicechange", enumerate);
    };
  }, []);

  return devices;
}
