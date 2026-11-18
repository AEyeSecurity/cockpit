let accountId: string | undefined;

export function setStorageAccount(id: string): void {
  accountId = id;
}

export function accountStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const storage = window.localStorage;
  if (!accountId) return storage;
  const prefix = "cockpit.account." + accountId + ".";
  return {
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: (key) => storage.removeItem(prefix + key)
  };
}
