import { Interface, isError } from 'ethers'
import type { JsonRpcProvider } from 'ethers'

/**
 * ERC-165 interface id of the Safe transaction Guard (checkTransaction ^ checkAfterExecution).
 * This is the exact interface Safe >= 1.4.0 enforces on-chain in `setGuard` (revert code GS300).
 * On Safe 1.3.0 there is no on-chain check, so this validation is the only safeguard.
 */
export const GUARD_INTERFACE_ID = '0xe6d7a83a'

export enum GuardValidity {
  VALID = 'VALID',
  NO_CODE = 'NO_CODE',
  UNSUPPORTED_INTERFACE = 'UNSUPPORTED_INTERFACE',
}

const erc165Interface = new Interface(['function supportsInterface(bytes4 interfaceId) view returns (bool)'])

/**
 * Validates whether an address is safe to enable as a Safe transaction guard.
 *
 * A guard must be a deployed contract that implements the Guard interface. Enabling anything
 * else (an EOA, or a contract without `checkTransaction`) reverts on every future
 * `execTransaction`, permanently bricking the Safe and freezing all its assets.
 *
 * A definitive negative verdict (`NO_CODE` / `UNSUPPORTED_INTERFACE`) means "not a valid guard".
 * A genuine provider/RPC failure (network / server / timeout) is re-thrown so the caller can fail
 * open rather than block a legitimate guard change on a transient error. A contract revert is NOT
 * a transient failure: it is a definitive "not a guard" answer.
 */
export const validateGuardTarget = async (guardAddress: string, provider: JsonRpcProvider): Promise<GuardValidity> => {
  // A network failure here propagates (fail open); an EOA simply returns '0x'.
  const code = await provider.getCode(guardAddress)

  if (!code || code === '0x') {
    return GuardValidity.NO_CODE
  }

  let returnData: string
  try {
    returnData = await provider.call({
      to: guardAddress,
      data: erc165Interface.encodeFunctionData('supportsInterface', [GUARD_INTERFACE_ID]),
    })
  } catch (error) {
    // A contract that does not implement ERC-165 reverts the call: a definitive "not a guard".
    if (isError(error, 'CALL_EXCEPTION')) {
      return GuardValidity.UNSUPPORTED_INTERFACE
    }
    // Any other failure (network / server / timeout) is transient: propagate so callers fail open.
    throw error
  }

  try {
    const [isSupported] = erc165Interface.decodeFunctionResult('supportsInterface', returnData)
    return isSupported ? GuardValidity.VALID : GuardValidity.UNSUPPORTED_INTERFACE
  } catch {
    // Empty or malformed return data: not a valid guard.
    return GuardValidity.UNSUPPORTED_INTERFACE
  }
}
