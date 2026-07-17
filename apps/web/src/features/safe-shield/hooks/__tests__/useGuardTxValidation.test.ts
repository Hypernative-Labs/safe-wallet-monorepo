import { Interface } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import type { SafeTransaction } from '@safe-global/types-kit'
import { OperationType } from '@safe-global/types-kit'
import { encodeMultiSendData } from '@safe-global/protocol-kit'
import { Multi_send__factory } from '@safe-global/utils/types/contracts/factories/@safe-global/safe-deployments/dist/assets/v1.3.0'
import { renderHook, waitFor } from '@/tests/test-utils'
import * as web3ReadOnly from '@/hooks/wallets/web3ReadOnly'
import * as exceptions from '@/services/exceptions'
import { useGuardTxValidation } from '../useGuardTxValidation'

// logError is exported non-configurably, so jest.spyOn cannot redefine it; mock the module instead.
jest.mock('@/services/exceptions', () => {
  const actual = jest.requireActual('@/services/exceptions')
  return { __esModule: true, ...actual, logError: jest.fn() }
})

const guardInterface = new Interface([
  'function setGuard(address guard)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
])

// CreateX - a real contract that is NOT a valid guard (the incident that motivated this check).
const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed'
const OTHER_GUARD = '0x1234567890123456789012345678901234567890'
const EOA_GUARD = '0x2222222222222222222222222222222222222222'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const SOME_CODE = '0x6080604052'

const encodeSetGuard = (address: string) => guardInterface.encodeFunctionData('setGuard', [address])
const encodeSupportsInterface = (value: boolean) => guardInterface.encodeFunctionResult('supportsInterface', [value])
const errorWithCode = (message: string, code: string): Error => Object.assign(new Error(message), { code })

const multiSendInterface = Multi_send__factory.createInterface()
const encodeMultiSend = (datas: string[]): string =>
  multiSendInterface.encodeFunctionData('multiSend', [
    encodeMultiSendData(datas.map((data) => ({ operation: OperationType.Call, to: CREATEX, value: '0', data }))),
  ])

const makeSafeTx = (data: string): SafeTransaction =>
  ({ data: { to: CREATEX, value: '0', data, operation: 0 } }) as unknown as SafeTransaction

const mockProvider = (opts: { getCode?: () => Promise<string>; call?: () => Promise<string> }): JsonRpcProvider =>
  ({
    getCode: jest.fn(opts.getCode ?? (() => Promise.resolve(SOME_CODE))),
    // Default: revert (non-guard) so an unconfigured guard target is treated as invalid.
    call: jest.fn(opts.call ?? (() => Promise.reject(errorWithCode('execution reverted', 'CALL_EXCEPTION')))),
  }) as unknown as JsonRpcProvider

describe('useGuardTxValidation', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  it('flags a setGuard tx whose target is not a valid guard', async () => {
    jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(mockProvider({}))

    const { result } = renderHook(() => useGuardTxValidation(makeSafeTx(encodeSetGuard(CREATEX))))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.invalidGuards).toHaveLength(1)
    })
    expect(result.current.invalidGuards[0].address.toLowerCase()).toBe(CREATEX.toLowerCase())
  })

  it('allows a setGuard tx whose target implements the Guard interface', async () => {
    const provider = mockProvider({ call: () => Promise.resolve(encodeSupportsInterface(true)) })
    jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(provider)

    const { result } = renderHook(() => useGuardTxValidation(makeSafeTx(encodeSetGuard(CREATEX))))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.invalidGuards).toHaveLength(0)
  })

  it('blocks (loading) a guard-setting tx synchronously until the current calldata is validated', async () => {
    const provider = mockProvider({ call: () => Promise.resolve(encodeSupportsInterface(true)) })
    jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(provider)

    const { result } = renderHook(() => useGuardTxValidation(makeSafeTx(encodeSetGuard(CREATEX))))

    // Pending before the async validation resolves: signing must be blocked, no result trusted yet.
    expect(result.current.loading).toBe(true)
    expect(result.current.invalidGuards).toHaveLength(0)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.invalidGuards).toHaveLength(0)
  })

  it('is an immediate no-op (no loading, no RPC) for a guard removal (setGuard to the zero address)', async () => {
    const provider = mockProvider({})
    jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(provider)

    const { result } = renderHook(() => useGuardTxValidation(makeSafeTx(encodeSetGuard(ZERO_ADDRESS))))

    expect(result.current.loading).toBe(false)
    expect(result.current.invalidGuards).toHaveLength(0)
    expect(provider.getCode).not.toHaveBeenCalled()
  })

  it('is an immediate no-op (no loading, no RPC) for a transaction that does not set a guard', async () => {
    const provider = mockProvider({})
    jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(provider)
    const erc20 = new Interface(['function transfer(address to, uint256 amount)'])
    const transferData = erc20.encodeFunctionData('transfer', [OTHER_GUARD, 1000])

    const { result } = renderHook(() => useGuardTxValidation(makeSafeTx(transferData)))

    expect(result.current.loading).toBe(false)
    expect(result.current.invalidGuards).toHaveLength(0)
    expect(provider.getCode).not.toHaveBeenCalled()
  })

  it('fails open (allows and logs _822) when the provider throws a genuine network error', async () => {
    const provider = mockProvider({ call: () => Promise.reject(errorWithCode('network down', 'NETWORK_ERROR')) })
    jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(provider)

    const { result } = renderHook(() => useGuardTxValidation(makeSafeTx(encodeSetGuard(CREATEX))))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.invalidGuards).toHaveLength(0)
    expect(exceptions.logError).toHaveBeenCalledWith(exceptions.Errors._822, expect.anything())
  })

  it('never allows a new guard tx using the previous transaction result (no stale bypass)', async () => {
    // First guard (CREATEX) is valid; a different second guard (OTHER_GUARD) is invalid.
    const provider = {
      getCode: jest.fn().mockResolvedValue(SOME_CODE),
      call: jest.fn((tx: { to: string }) =>
        tx.to.toLowerCase() === CREATEX.toLowerCase()
          ? Promise.resolve(encodeSupportsInterface(true))
          : Promise.reject(errorWithCode('execution reverted', 'CALL_EXCEPTION')),
      ),
    } as unknown as JsonRpcProvider
    jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(provider)

    const { result, rerender } = renderHook((tx: SafeTransaction | undefined) => useGuardTxValidation(tx), {
      initialProps: makeSafeTx(encodeSetGuard(CREATEX)) as SafeTransaction | undefined,
    })

    // First tx validates as a valid guard -> allowed.
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.invalidGuards).toHaveLength(0)

    // Supply a new guard-setting tx: it must be blocked immediately, not allowed by the stale result.
    rerender(makeSafeTx(encodeSetGuard(OTHER_GUARD)))
    expect(result.current.loading).toBe(true)
    expect(result.current.invalidGuards).toHaveLength(0)

    // Once the new calldata is validated, the invalid guard is flagged.
    await waitFor(() => expect(result.current.invalidGuards).toHaveLength(1))
    expect(result.current.loading).toBe(false)
    expect(result.current.invalidGuards[0].address.toLowerCase()).toBe(OTHER_GUARD.toLowerCase())
  })

  it('blocks on a definitive invalid guard even when another target in the same batch fails RPC', async () => {
    const provider = {
      getCode: jest.fn((address: string) =>
        address.toLowerCase() === EOA_GUARD.toLowerCase() ? Promise.resolve('0x') : Promise.resolve(SOME_CODE),
      ),
      // The contract-backed target's ERC-165 call fails with a transient network error.
      call: jest.fn(() => Promise.reject(errorWithCode('network down', 'NETWORK_ERROR'))),
    } as unknown as JsonRpcProvider
    jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(provider)

    // MultiSend that sets an EOA (definitively invalid) plus a second guard whose RPC check fails.
    const data = encodeMultiSend([encodeSetGuard(EOA_GUARD), encodeSetGuard(OTHER_GUARD)])
    const { result } = renderHook(() => useGuardTxValidation(makeSafeTx(data)))

    await waitFor(() => expect(result.current.loading).toBe(false))
    // The EOA guard is a definitive invalid verdict and must still block despite the other failure.
    expect(result.current.invalidGuards).toHaveLength(1)
    expect(result.current.invalidGuards[0].address.toLowerCase()).toBe(EOA_GUARD.toLowerCase())
    // The flaky target was logged and skipped, not allowed to discard the invalid verdict.
    expect(exceptions.logError).toHaveBeenCalledWith(exceptions.Errors._822, expect.anything())
  })

  it('re-blocks synchronously when the read-only provider is replaced (no stale-provider bypass)', async () => {
    const validProvider = mockProvider({ call: () => Promise.resolve(encodeSupportsInterface(true)) })
    const useWeb3ReadOnly = jest.spyOn(web3ReadOnly, 'useWeb3ReadOnly').mockReturnValue(validProvider)

    const safeTx = makeSafeTx(encodeSetGuard(CREATEX))
    const { result, rerender } = renderHook((tx: SafeTransaction) => useGuardTxValidation(tx), {
      initialProps: safeTx,
    })

    // Guard validates as valid under the first provider -> allowed.
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.invalidGuards).toHaveLength(0)

    // Replace the provider (same calldata). The previous provider's result must not be trusted.
    const invalidProvider = mockProvider({
      call: () => Promise.reject(errorWithCode('execution reverted', 'CALL_EXCEPTION')),
    })
    useWeb3ReadOnly.mockReturnValue(invalidProvider)
    rerender(safeTx)

    // Blocked synchronously on the provider swap, not enabled by the stale outcome.
    expect(result.current.loading).toBe(true)
    expect(result.current.invalidGuards).toHaveLength(0)

    // The new provider's validation flags the guard as invalid.
    await waitFor(() => expect(result.current.invalidGuards).toHaveLength(1))
    expect(result.current.loading).toBe(false)
  })
})
