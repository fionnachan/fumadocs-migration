'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';

/**
 * The cross-section links pinned under every section sidebar, passed to the notebook layout as
 * `sidebar.footer` from app/docs/layout.tsx.
 *
 * These three used to be `"[Chain info](/docs/chain-info)"`-style entries repeated in all eleven
 * root `meta.json` files (commit 6b83156). A `pages` link entry becomes a real `type: "page"` node
 * in the page tree, so the depth-first path search found the duplicate before the real page and
 * handed each target the linking section's sidebar root; that is the defect FS-2716 fixes, and
 * `pnpm nav:check` now fails on it. The footer slot renders after the page tree and never enters
 * it, so the affordance comes back with no way to shadow anything.
 *
 * Passed as a component, not as an element. fumadocs-ui's `renderFooter`
 * (`fumadocs-ui/dist/layouts/notebook/slots/sidebar.js`) wraps a plain ReactNode in its own
 * container, whose className starts with `hidden` and only gains a display class when there are
 * icon menu items (desktop) or a language/theme slot (drawer). This app declares no icon items, so
 * a ReactNode footer would be in the DOM and invisible on desktop. The function form gets
 * `createElement(footer, props)` instead, which puts the className under our control. The
 * library's own footer row is still rendered below, with its props untouched, so the theme switch
 * in the mobile drawer is unaffected.
 */
const RESOURCE_LINKS = [
  { text: 'Chain info', url: '/docs/chain-info' },
  { text: 'Audit reports', url: '/docs/audit-reports' },
  { text: 'Contribute', url: '/docs/contribute' },
];

// Copied from `itemVariants({ variant: 'link' })` in the notebook sidebar slot, minus the depth
// offset, so a footer link is visually the same object as a tree link.
const ITEM_CLASS =
  'relative flex flex-row items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground wrap-anywhere transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 hover:transition-none data-[active=true]:bg-fd-primary/10 data-[active=true]:text-fd-primary data-[active=true]:hover:transition-colors';

export function SidebarResourceLinks({ children, ...props }: ComponentProps<'div'>) {
  const pathname = usePathname();

  return (
    <>
      <div className="flex flex-col gap-0.5 border-t p-2">
        {RESOURCE_LINKS.map((link) => (
          <Link
            key={link.url}
            href={link.url}
            data-active={pathname === link.url}
            className={ITEM_CLASS}
          >
            {link.text}
          </Link>
        ))}
      </div>
      <div {...props}>{children}</div>
    </>
  );
}
