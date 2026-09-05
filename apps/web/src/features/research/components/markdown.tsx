import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/shared/lib/utils';

/**
 * The living document is agent-authored markdown. react-markdown renders to
 * React nodes with no `dangerouslySetInnerHTML` and, without rehype-raw, any
 * embedded HTML is treated as plain text — so the surface stays XSS-safe by
 * construction. remark-gfm adds tables, strikethrough and autolinks, which the
 * research write-ups lean on for comparison tables.
 */
const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-1 mb-3 text-2xl font-semibold tracking-tight text-balance">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 mb-2 text-xs font-semibold tracking-[0.07em] text-muted-foreground uppercase">
      {children}
    </h2>
  ),
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold">{children}</h3>,
  p: ({ children }) => <p className="my-3 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? '');
    if (isBlock) {
      return <code className="font-mono text-[13px] leading-relaxed">{children}</code>;
    }
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-lg border border-border/60 bg-muted/50 p-3">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>
  ),
  hr: () => <hr className="my-5 border-border/60" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('text-[15px] text-foreground', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
