"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const t = localStorage.getItem("theme");
    if (t === "light" || t === "dark") setTheme(t);
  }, []);

  function choose(t: Theme) {
    setTheme(t);
    if (t === "system") {
      localStorage.removeItem("theme");
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem("theme", t);
      document.documentElement.dataset.theme = t;
    }
  }

  return (
    <div role="group" aria-label="Theme" className="theme-toggle">
      {(["system", "light", "dark"] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => choose(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}
