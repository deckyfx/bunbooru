import { Link } from "@tanstack/react-router";

import type { MarkupToken } from "@bunbooru/plugin-wiki/markup";

/**
 * A tokenized wiki body as React elements: text verbatim (newlines kept by
 * `whitespace-pre-wrap`), `[[Title]]` as a link to that page and `{{tag}}` as a
 * link to its post search. Never HTML: text is a React string child, so a body
 * can't inject markup.
 */
export function WikiBody({ tokens, className = "" }: { tokens: readonly MarkupToken[]; className?: string }) {
  return (
    <div className={`whitespace-pre-wrap break-words text-[13px] ${className}`}>
      {tokens.map((token, i) => {
        switch (token.type) {
          case "text":
            return <span key={i}>{token.text}</span>;
          case "wiki":
            return (
              <Link key={i} to="/wiki/$title" params={{ title: token.title }} className="text-link hover:underline">
                {token.label}
              </Link>
            );
          case "search":
            return (
              <Link key={i} to="/posts" search={{ q: token.tag }} className="text-link hover:underline">
                {token.label}
              </Link>
            );
        }
      })}
    </div>
  );
}
