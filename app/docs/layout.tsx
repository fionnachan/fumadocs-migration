import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import type { CSSProperties, ReactNode } from 'react';

import { SidebarCollapseButton } from '@/components/sidebar-collapse-button';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  const base = baseOptions();
  return (
    <DocsLayout
      {...base}
      // The key is load-bearing. fumadocs-ui's notebook Header builds
      // `[navTitle, nav.children]` as a literal array
      // (dist/layouts/notebook/slots/header.js). A literal array's own
      // elements are pre-validated when built, but this one crosses the
      // server-client boundary as a lazy reference and is checked only
      // once resolved, so a real key is what satisfies it. No gate opens
      // a browser, so nothing catches its removal.
      nav={{ ...base.nav, mode: 'top', children: <SidebarCollapseButton key="sidebar-collapse" /> }}
      // Suppresses the built-in collapse triggers only — the sidebar still
      // collapses. Collapse state lives in SidebarProvider and the edge-peek in
      // SidebarContent, neither of which reads this flag. SidebarCollapseButton
      // above replaces the trigger this removes from the navbar's right cluster.
      sidebar={{ collapsible: false }}
      tree={source.pageTree}
      tabs={{
        transform(option, node) {
          if (!node.icon) return option;
          return {
            ...option,
            icon: (
              <div
                className="[&_svg]:size-full size-full rounded-md border p-1.5 text-fd-primary max-md:bg-fd-primary/10"
                style={{ '--tab-color': 'var(--color-fd-primary)' } as CSSProperties}
              >
                {node.icon}
              </div>
            ),
          };
        },
      }}
    >
      {children}
    </DocsLayout>
  );
}
