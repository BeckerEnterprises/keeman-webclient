import * as kdbxweb from "kdbxweb";

const HEX32 = /^[0-9a-f]{32}$/;

/** 32 lowercase hex digits; the form KeePass uses in `{REF}`. */
export function hexOfUuid(uuid: kdbxweb.KdbxUuid): string {
  return [...new Uint8Array(uuid.bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function uuidOfHex(hex: string): kdbxweb.KdbxUuid {
  if (!HEX32.test(hex)) throw new RangeError("Invalid UUID");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return new kdbxweb.KdbxUuid(bytes.buffer);
}
