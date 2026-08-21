import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Opens one stable regular-file path without relying on platform O_NOFOLLOW support alone. */
export async function openRegularFileNoFollow(pathname: string, message: string): Promise<FileHandle> {
  const before = await lstat(pathname);
  if (!before.isFile() || before.isSymbolicLink()) throw new TypeError(message);

  const handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(pathname)]);
    if (!opened.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || !sameFileIdentity(opened, current)) {
      throw new TypeError(message);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
