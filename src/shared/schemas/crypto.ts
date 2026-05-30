import { z } from 'zod'

export const CryptoResultSchema = z.object({
  iv: z.string().min(1),
  cipher: z.string().min(1),
})
