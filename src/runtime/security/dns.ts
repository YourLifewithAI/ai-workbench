// Broker-side DNS with address pinning (D-28, SEC-17). Every answer is checked, one is pinned, and that pinned
// address is what the socket dials — so a name that resolves to a private address is caught, and a second
// lookup between the check and the connect cannot change the answer underneath us.
import dns from 'node:dns';
import { isLocalAddress } from './egress.js';

export interface ResolvedAddress { address: string; family: 4 | 6 }

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

/** The real resolver. Injectable, so a test can point `*.test` at a TEST-NET-3 address without a DNS server. */
export const systemLookup: LookupFn = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
};

export interface PinResult {
  ok: true;
  /** The address the socket must dial. The hostname still travels as SNI and in the Host header. */
  address: string;
  family: 4 | 6;
  all: string[];
}
export interface PinFailure { ok: false; reason: string; addresses: string[] }

/**
 * One blocked answer blocks the whole request. A host that resolves to both a public and a private address is
 * the shape of a rebinding attack, and picking the public one would be doing the attacker's work.
 */
export async function resolveAndPin(hostname: string, lookup: LookupFn, allowLocalAddresses: boolean): Promise<PinResult | PinFailure> {
  let answers: ResolvedAddress[];
  try {
    answers = await lookup(hostname);
  } catch (e) {
    return { ok: false, reason: `${hostname} does not resolve: ${(e as Error).message}`, addresses: [] };
  }
  if (!answers.length) return { ok: false, reason: `${hostname} resolves to no address at all.`, addresses: [] };

  const addresses = answers.map((a) => a.address);
  if (!allowLocalAddresses) {
    const blocked = answers.find((a) => isLocalAddress(a.address));
    if (blocked) {
      return {
        ok: false,
        reason: `${hostname} resolves to ${blocked.address}, which is a private or loopback address. Set network.allowLocalAddresses if you meant to reach it.`,
        addresses,
      };
    }
  }
  const first = answers[0]!;
  return { ok: true, address: first.address, family: first.family, all: addresses };
}
