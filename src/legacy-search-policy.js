/**
 * When to run the old client-side search over the browser's local store.
 *
 * The local store holds only recently captured messages and its search has
 * none of the server's quality filters. It stands in when the server search
 * could not run. It must not second-guess a server search that ran and found
 * nothing relevant.
 *
 * @param {{routingMode: string, itemCount: number, searchFailed: boolean, testMode?: boolean}} state
 * @returns {boolean}
 */
export function shouldUseLegacySearch({ routingMode, itemCount, searchFailed, testMode = false }) {
  if (testMode) return false;
  if (routingMode !== 'edge') return true;
  return Boolean(searchFailed) && itemCount === 0;
}
