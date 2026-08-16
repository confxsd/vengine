/**
 * Admin-password prompt for the deployed studio. The app is fully browsable
 * without auth — this modal appears only when a gated (paid / mutating)
 * request comes back 401. On success the server sets the session cookie and
 * the caller retries the original request once.
 */

const GITHUB_URL = "https://github.com/confxsd/vengine";

let active: Promise<boolean> | null = null;

/** Open the prompt (at most one at a time); resolves true once logged in. */
export function ensureAuth(): Promise<boolean> {
  active ??= openPrompt().finally(() => {
    active = null;
  });
  return active;
}

function openPrompt(): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed;inset:0;z-index:9999;display:grid;place-items:center",
      "background:rgba(5,7,10,.72);backdrop-filter:blur(3px)",
    ].join(";");
    overlay.innerHTML = `
      <div class="vp-card" style="
        width:min(92vw,360px);padding:30px 28px;border-radius:14px;
        background:#14171c;border:1px solid #232830;color:#e6e8ec;
        font:14px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
        box-shadow:0 18px 50px rgba(0,0,0,.5)">
        <h2 style="margin:0 0 6px;font-size:19px">Sign in to edit &amp; generate</h2>
        <p style="margin:0 0 18px;color:#8b93a1;font-size:13px">
          Browsing is free — generating runs on the owner's fal credits, so it
          needs the admin password.
        </p>
        <input id="vp-pass" type="password" placeholder="Admin password"
          autocomplete="current-password" style="
            width:100%;padding:10px 12px;border-radius:8px;font-size:14px;
            border:1px solid #2b323d;background:#0f1216;color:#e6e8ec;outline:none"/>
        <p id="vp-err" style="display:none;margin:10px 0 0;color:#f87171;font-size:13px">
          Wrong password — try again.
        </p>
        <button id="vp-go" style="
          width:100%;margin-top:12px;padding:10px;border:0;border-radius:8px;
          background:#e6e8ec;color:#0b0d10;font-size:14px;font-weight:600;cursor:pointer">
          Sign in
        </button>
        <p style="margin:16px 0 0;color:#8b93a1;font-size:12.5px;text-align:center">
          No password? <a href="${GITHUB_URL}" target="_blank" rel="noreferrer"
            style="color:#93c5fd">Run it locally</a> — the engine is open source.
        </p>
      </div>`;

    const input = overlay.querySelector<HTMLInputElement>("#vp-pass")!;
    const err = overlay.querySelector<HTMLElement>("#vp-err")!;
    const go = overlay.querySelector<HTMLButtonElement>("#vp-go")!;

    const close = (ok: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(ok);
    };

    const tryLogin = async () => {
      const password = input.value;
      go.disabled = true;
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (res.ok) return close(true);
        err.style.display = "block";
        input.select();
      } catch {
        err.textContent = "Could not reach the server — try again.";
        err.style.display = "block";
      } finally {
        go.disabled = false;
      }
    };

    go.addEventListener("click", () => void tryLogin());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void tryLogin();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
  });
}
