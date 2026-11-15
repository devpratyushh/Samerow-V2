import { browserId } from './browserId.js';

const storageKey = 'mellettem.room-tab';
let roomTab;

function claimTab(id) {
  return new Promise(resolve => {
    navigator.locks.request(`${storageKey}:${id}`, { ifAvailable: true }, lock => {
      resolve(Boolean(lock));
      // The browser releases the lock when this document goes away.
      if (lock) return new Promise(() => {});
    }).catch(() => resolve(false));
  });
}

async function identifyTab() {
  const fresh = { id: browserId(), persistent: false };
  if (!navigator.locks) return fresh;
  try {
    const saved = sessionStorage.getItem(storageKey);
    const id = saved && /^[a-f0-9-]{36}$/i.test(saved) && await claimTab(saved) ? saved : fresh.id;
    if (id === fresh.id && !await claimTab(id)) return fresh;
    // Duplicated tabs can inherit sessionStorage, but only one can claim its ID.
    sessionStorage.setItem(storageKey, id);
    return { id, persistent: true };
  } catch {
    return fresh;
  }
}

export function getRoomTab() {
  roomTab ??= identifyTab();
  return roomTab;
}
