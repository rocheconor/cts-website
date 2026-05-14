// Tiny module-level holder so log.js (and anything else low-level) can
// write to the currently-loaded session's Firestore subcollection without
// taking a dependency on the orchestrator (would be an import cycle).
// The orchestrator is the only writer.

let _currentSessionId = null;

export const setCurrentSessionId = (id) => {
    _currentSessionId = id || null;
};

export const getCurrentSessionId = () => _currentSessionId;
