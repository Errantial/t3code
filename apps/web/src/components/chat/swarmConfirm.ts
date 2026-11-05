import { requestConfirmDialog } from "~/confirmDialog";

/**
 * Confirms a swarm action. Without a themed dialog host, the browser's own confirm asks
 * instead: a missing host never counts as a yes.
 */
export async function confirmSwarmAction(
  message: string,
  fallback: (message: string) => boolean = (text) => window.confirm(text),
): Promise<boolean> {
  return (await requestConfirmDialog(message)) ?? fallback(message);
}
