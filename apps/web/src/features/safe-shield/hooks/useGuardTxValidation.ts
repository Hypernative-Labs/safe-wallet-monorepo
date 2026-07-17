import { useMemo } from 'react'
import type { JsonRpcProvider } from 'ethers'
import type { SafeTransaction } from '@safe-global/types-kit'
import useAsync from '@safe-global/utils/hooks/useAsync'
import { ZERO_ADDRESS } from '@safe-global/utils/utils/constants'
import { useWeb3ReadOnly } from '@/hooks/wallets/web3ReadOnly'
import { logError, Errors } from '@/services/exceptions'
import { getGuardsBeingSet } from '@/utils/transaction-calldata'
import { validateGuardTarget, GuardValidity } from '../services/guardValidation'

export type InvalidGuard = {
  address: string
  validity: GuardValidity
}

export type GuardTxValidationResult = {
  invalidGuards: InvalidGuard[]
  loading: boolean
}

type ValidationOutcome = {
  key: string
  provider: JsonRpcProvider
  invalidGuards: InvalidGuard[]
}

/**
 * Validates any transaction guard a transaction would enable via setGuard before it is signed.
 *
 * Returns the guard targets that are NOT valid guards (an EOA, or a contract that does not
 * implement the Guard interface). Enabling such a guard permanently bricks the Safe, so the
 * sign flow must block while validation is pending and on any non-empty result.
 *
 * A guard-setting transaction is reported as `loading` synchronously - derived from whether a
 * result exists for the *current* calldata and the *current* provider, not from the async effect's
 * loading flag - so neither the initial render, a stale result from a previous transaction, nor a
 * result from a replaced provider can briefly enable signing. Non-guard transactions and guard
 * removals (setGuard to the zero address) are immediate no-ops with no loading state.
 *
 * Each target is validated independently: a definitive invalid verdict always blocks, while a
 * transient/unknown RPC failure for a single target is logged (`_822`) and skipped without
 * discarding the verdicts of the other targets.
 */
export const useGuardTxValidation = (safeTx?: SafeTransaction): GuardTxValidationResult => {
  const provider = useWeb3ReadOnly()

  const guardAddresses = useMemo(() => {
    if (!safeTx) return []

    // Removing a guard (zero address) is safe and must not be flagged.
    return getGuardsBeingSet({ data: safeTx.data.data }).filter(
      (address) => address.toLowerCase() !== ZERO_ADDRESS.toLowerCase(),
    )
  }, [safeTx])

  // Identifies the exact work for the current calldata, so a result computed for a previous
  // transaction can never be trusted for this one. Provider identity is matched separately below.
  const validationKey = useMemo(() => guardAddresses.join(','), [guardAddresses])

  const [outcome] = useAsync<ValidationOutcome>(
    () => {
      // Nothing to validate, or no provider to validate with yet: do no async work. Returning
      // `undefined` (rather than a resolved empty result) keeps no-op transactions free of any
      // post-render state update, while `hasGuardToValidate`/`isCurrent` below keep a pending guard
      // transaction blocked until a real result arrives.
      if (guardAddresses.length === 0 || !provider) {
        return undefined
      }

      const currentProvider = provider

      return Promise.all(
        guardAddresses.map(async (address) => {
          try {
            return { address, validity: await validateGuardTarget(address, currentProvider) }
          } catch (error) {
            // Transient/unknown failure for THIS target only: log and fail open for it, without
            // discarding the definitive verdicts of the other targets in the batch.
            logError(Errors._822, error)
            return null
          }
        }),
      ).then((results) => ({
        key: validationKey,
        provider: currentProvider,
        invalidGuards: results.filter(
          (result): result is InvalidGuard => result !== null && result.validity !== GuardValidity.VALID,
        ),
      }))
    },
    [guardAddresses, provider, validationKey],
    true,
  )

  // Only trust a result computed for the current calldata AND the current provider.
  const isCurrent = outcome?.key === validationKey && outcome?.provider === provider
  const hasGuardToValidate = guardAddresses.length > 0

  return {
    invalidGuards: isCurrent && outcome ? outcome.invalidGuards : [],
    loading: hasGuardToValidate && !isCurrent,
  }
}
