/** The message of an `Error`, or anything else thrown as a string */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
