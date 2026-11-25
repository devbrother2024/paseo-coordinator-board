// The one place that answers a waiting request. A person's button on the board and the read-only
// rule a person switched on both send through here, so both read the session again first, answer
// only a request that is still waiting, and never answer one twice.
export type Outcome = "sent" | "handled" | "unconfirmed" | "failed" | "busy";
export type AgentPort<Response> = {
  refresh(): Promise<{ agent: { pendingPermissions: readonly { id: string }[] } } | null>;
  respondToPermission(options: { requestId: string; response: Response }): Promise<void>;
};

// Sends one response to one waiting request. It first reads the session again and sends only
// when that request is still waiting, takes one response at a time, and never sends a request twice.
// The host does not acknowledge a response, so the result is confirmed by the request leaving the list.
// `wasSent` and `onSent` keep the record of sent requests outside the caller that started the response.
export function createResponder<Response>(agent: AgentPort<Response>, { checks = 10, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  wasSent = () => false, onSent = () => {} }: {
  checks?: number; wait?: (ms: number) => Promise<void>; wasSent?: (requestId: string) => boolean; onSent?: (requestId: string) => void;
} = {}) {
  let busy = false;
  const sent = new Set<string>();
  const waiting = async (requestId: string) => {
    const result = await agent.refresh();
    return result ? result.agent.pendingPermissions.some(request => request.id === requestId) : null;
  };
  const cleared = async (requestId: string) => {
    try { return await waiting(requestId) === false; } catch { return false; }
  };
  async function once(work: () => Promise<Outcome>): Promise<Outcome> {
    if (busy) return "busy";
    busy = true;
    try { return await work(); } finally { busy = false; }
  }
  return {
    // Reads whether a response that already went out was taken. It sends nothing.
    check: (requestId: string) => once(async () => await cleared(requestId) ? "sent" : "unconfirmed"),
    respond: (requestId: string, response: Response) => once(async () => {
      if (sent.has(requestId) || wasSent(requestId)) return await cleared(requestId) ? "sent" : "unconfirmed";
      let current: boolean | null;
      try { current = await waiting(requestId); } catch { return "failed"; }
      if (current === null) return "failed";
      if (!current) return "handled";
      try { await agent.respondToPermission({ requestId, response }); } catch { return "failed"; }
      sent.add(requestId);
      try { onSent(requestId); } catch { /* The response went out. Recording it must not undo that. */ }
      for (let attempt = 0; attempt < checks; attempt++) {
        await wait(400);
        if (await cleared(requestId)) return "sent";
      }
      return "unconfirmed";
    }),
  };
}
