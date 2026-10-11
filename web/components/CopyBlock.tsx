"use client";

import { useRef, useState } from "react";

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = pre.current;
      if (el) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
    }
  }

  return (
    <div className="copy-block">
      <pre ref={pre} className="json mono copy-text" aria-label={label}>{text}</pre>
      <button type="button" onClick={copy} aria-label={label ? `Copy ${label}` : "Copy"}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}
