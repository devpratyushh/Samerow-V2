// Keep the latest local intent while older snapshots and command echoes arrive.
export function createPendingPlayback() {
  let pending = null;
  let commands = new Set();
  return {
    reset() { pending = null; commands.clear(); },
    begin(state, id, now) {
      if (pending?.sessionId !== state.sessionId) commands.clear();
      commands.add(id);
      if (commands.size > 100) commands.delete(commands.values().next().value);
      pending = { sessionId: state.sessionId, revision: state.revision, id, expires: now + 5000 };
    },
    accept(state, now) {
      if (!pending) return true;
      if (!state || state.sessionId !== pending.sessionId || now >= pending.expires || state.commandId === pending.id) {
        pending = null;
        commands.clear();
        return true;
      }
      if (state.revision <= pending.revision || commands.has(state.commandId)) return false;
      pending = null;
      commands.clear();
      return true;
    },
  };
}
