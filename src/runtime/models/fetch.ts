// The one place a model call touches the network. RUN-02 replaces the body of `directFetch` with the egress
// checker (SSRF defences, network modes, the egress log); every adapter already receives its fetch by injection,
// so that change lands here and nowhere else.
import type { FetchLike } from './adapter.js';

export const directFetch: FetchLike = (input, init) => fetch(input as RequestInfo, init);

/** Used until a run is allowed out: every adapter call fails closed with a NetworkPolicy error. */
export function offlineFetch(reason: string): FetchLike {
  return async () => {
    const { NetworkPolicyError } = await import('./errors.js');
    throw new NetworkPolicyError(reason);
  };
}
