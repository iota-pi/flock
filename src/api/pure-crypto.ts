export function toBytes(str: string): ArrayBuffer {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0))).buffer
}
