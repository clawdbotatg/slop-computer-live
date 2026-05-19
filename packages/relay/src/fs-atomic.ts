import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Atomic file replacement: write to a sibling tempfile, then rename
// over the target. On every POSIX filesystem we run on (ext4 on the
// prod box, APFS on macOS dev), rename() within the same directory is
// atomic — readers either see the old content or the new, never a
// truncated half-write.
//
// Why this matters: every subsystem's `persist()` is called on a hot
// path (chess move, wallet sig, todo toggle…) and a crash mid-write
// without the rename trick can leave a 0-byte or partial JSON file.
// Next boot then loses that subsystem's state for the room. With this
// helper the worst case is a stray `.tmp` file in the room dir.
//
// Tempfile names include pid + random suffix so concurrent persists
// (same process, different in-flight callers) don't trample each other
// while in flight.

export function writeFileAtomic(filePath: string, contents: string | Buffer): void {
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmp, contents);
    renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the tempfile so we don't litter the dir
    // with corpses from failed writes.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore — file may not exist */
    }
    throw err;
  }
}
