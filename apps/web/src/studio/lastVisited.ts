/** Remembers the last character whose System page was open, so the nav rail's
 *  one-click entry can land on the character you were actually working on.
 *  localStorage access is guarded — privacy modes may throw. */
const KEY = "vengine.lastSystemCharacterId";

export function rememberSystemCharacter(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable — the rail entry just falls back to the first character */
  }
}

export function lastSystemCharacter(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
