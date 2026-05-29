// Preview-only fake publication sets. Hooked up to the
// `?fakeLayout=<preset>` URL param so we can iterate on each of the 5
// MobileStage layouts without needing real publishers in the room.
// Fake pubs carry stable streamIds + ownerKeys so the layout dispatcher
// sees them as a real publisher set; tiles render with NO MediaStream
// (the "connecting…" / avatar placeholder), so this is preview-only —
// real publishers will always show real video.
import type { Publication } from "~~/hooks/usePeerMesh";

export type FakePreset =
  | "idle"
  | "1cam"
  | "2cam"
  | "3cam"
  | "4cam"
  | "screen"
  | "screen-cam"
  | "screen-2cam"
  | "2screen"
  | "audio"
  | "cam-audio"
  | "2cam-2audio";

export const FAKE_PRESETS: FakePreset[] = [
  "idle",
  "1cam",
  "2cam",
  "3cam",
  "4cam",
  "screen",
  "screen-cam",
  "screen-2cam",
  "2screen",
  "audio",
  "cam-audio",
  "2cam-2audio",
];

function cam(i: number): Publication {
  return {
    streamId: `fake-cam-${i}`,
    peerId: `fake-peer-${i}`,
    ownerKey: `fake-owner-${i}`,
    kind: "camera",
    label: `cam ${i}`,
  };
}

function audio(i: number): Publication {
  return {
    streamId: `fake-audio-${i}`,
    peerId: `fake-peer-audio-${i}`,
    ownerKey: `fake-audio-owner-${i}`,
    kind: "audio",
    label: `audio ${i}`,
  };
}

function screen(i: number): Publication {
  return {
    streamId: `fake-screen-${i}`,
    peerId: `fake-peer-screen-${i}`,
    ownerKey: `fake-screen-owner-${i}`,
    kind: "screen",
    label: `screen ${i}`,
  };
}

export function fakePubsFor(preset: FakePreset): Publication[] {
  switch (preset) {
    case "idle":
      return [];
    case "1cam":
      return [cam(1)];
    case "2cam":
      return [cam(1), cam(2)];
    case "3cam":
      return [cam(1), cam(2), cam(3)];
    case "4cam":
      return [cam(1), cam(2), cam(3), cam(4)];
    case "screen":
      return [screen(1)];
    case "screen-cam":
      return [cam(1), screen(1)];
    case "screen-2cam":
      return [cam(1), cam(2), screen(1)];
    case "2screen":
      return [screen(1), screen(2)];
    case "audio":
      return [audio(1)];
    case "cam-audio":
      return [cam(1), audio(1)];
    case "2cam-2audio":
      return [cam(1), cam(2), audio(1), audio(2)];
    default:
      return [];
  }
}

export function isFakePreset(value: string): value is FakePreset {
  return (FAKE_PRESETS as string[]).includes(value);
}
