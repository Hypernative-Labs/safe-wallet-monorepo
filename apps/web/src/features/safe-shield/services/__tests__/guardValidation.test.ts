import { Interface } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { validateGuardTarget, GuardValidity } from '../guardValidation'

const GUARD_ADDRESS = '0x1111111111111111111111111111111111111111'
const SOME_CODE = '0x6080604052'

const erc165Interface = new Interface(['function supportsInterface(bytes4 interfaceId) view returns (bool)'])
const encodeSupportsInterface = (value: boolean) => erc165Interface.encodeFunctionResult('supportsInterface', [value])
const errorWithCode = (message: string, code: string): Error => Object.assign(new Error(message), { code })

const withCode = (code: string, call?: () => Promise<string>): JsonRpcProvider =>
  ({
    getCode: jest.fn().mockResolvedValue(code),
    call: jest.fn(call ?? (() => Promise.resolve(encodeSupportsInterface(true)))),
  }) as unknown as JsonRpcProvider

describe('validateGuardTarget', () => {
  it('returns NO_CODE for an address without deployed code (EOA)', async () => {
    const provider = withCode('0x')

    await expect(validateGuardTarget(GUARD_ADDRESS, provider)).resolves.toBe(GuardValidity.NO_CODE)
    expect(provider.call).not.toHaveBeenCalled()
  })

  it('returns VALID when the contract supports the Guard interface', async () => {
    const provider = withCode(SOME_CODE, () => Promise.resolve(encodeSupportsInterface(true)))

    await expect(validateGuardTarget(GUARD_ADDRESS, provider)).resolves.toBe(GuardValidity.VALID)
  })

  it('returns UNSUPPORTED_INTERFACE when supportsInterface returns false', async () => {
    const provider = withCode(SOME_CODE, () => Promise.resolve(encodeSupportsInterface(false)))

    await expect(validateGuardTarget(GUARD_ADDRESS, provider)).resolves.toBe(GuardValidity.UNSUPPORTED_INTERFACE)
  })

  it('returns UNSUPPORTED_INTERFACE when the call reverts (non-ERC165 contract like CreateX)', async () => {
    const provider = withCode(SOME_CODE, () => Promise.reject(errorWithCode('execution reverted', 'CALL_EXCEPTION')))

    await expect(validateGuardTarget(GUARD_ADDRESS, provider)).resolves.toBe(GuardValidity.UNSUPPORTED_INTERFACE)
  })

  it('returns UNSUPPORTED_INTERFACE when the call returns empty/malformed data', async () => {
    const provider = withCode(SOME_CODE, () => Promise.resolve('0x'))

    await expect(validateGuardTarget(GUARD_ADDRESS, provider)).resolves.toBe(GuardValidity.UNSUPPORTED_INTERFACE)
  })

  it('propagates a genuine network error from provider.call (so the caller can fail open)', async () => {
    const provider = withCode(SOME_CODE, () =>
      Promise.reject(errorWithCode('could not detect network', 'NETWORK_ERROR')),
    )

    await expect(validateGuardTarget(GUARD_ADDRESS, provider)).rejects.toThrow('could not detect network')
  })

  it('propagates a genuine network error from getCode', async () => {
    const provider = {
      getCode: jest.fn().mockRejectedValue(errorWithCode('timeout', 'TIMEOUT')),
      call: jest.fn(),
    } as unknown as JsonRpcProvider

    await expect(validateGuardTarget(GUARD_ADDRESS, provider)).rejects.toThrow('timeout')
    expect(provider.call).not.toHaveBeenCalled()
  })
})
