import * as Automerge from '@automerge/automerge'
import type { VaultBranch } from '../../shared/itemTypes'
import { decodeEncryptedAutomergeDoc } from '../../shared/automergeBranchCipher'

export type DecryptAndMergeAutomergeResult = {
  mergedDoc: Automerge.Doc<unknown>
  mergedBinary: Uint8Array
}

async function decryptBranch(branch: VaultBranch, key: CryptoKey): Promise<Automerge.Doc<unknown>> {
  const encryptedDoc = branch.encryptedAutomergeDoc
  const decoded = decodeEncryptedAutomergeDoc(encryptedDoc)

  const binary = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decoded.iv },
    key,
    decoded.cipher,
  )

  return Automerge.load(new Uint8Array(binary))
}

export async function decryptAndMergeAutomerge(
  branches: VaultBranch[],
  key: CryptoKey,
): Promise<DecryptAndMergeAutomergeResult> {
  if (branches.length === 0) {
    const mergedDoc = Automerge.from({})
    return {
      mergedDoc,
      mergedBinary: Automerge.save(mergedDoc),
    }
  }

  const docs = await Promise.all(branches.map(branch => decryptBranch(branch, key)))

  let mergedDoc = docs[0]
  for (let index = 1; index < docs.length; index += 1) {
    mergedDoc = Automerge.merge(mergedDoc, docs[index])
  }

  return {
    mergedDoc,
    mergedBinary: Automerge.save(mergedDoc),
  }
}
