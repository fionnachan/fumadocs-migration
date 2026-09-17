import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import type { CSSProperties, ReactNode } from 'react';

import { SidebarCollapseButton } from '@/components/sidebar-collapse-button';
import { SidebarResourceLinks } from '@/components/sidebar-resource-links';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  const base = baseOptions();
  return (
    <DocsLayout
      {...base}
      nav={{ ...base.nav, mode: 'top', children: <SidebarCollapseButton /> }}
      // Suppresses the built-in collapse triggers only — the sidebar still
      // collapses. Collapse state lives in SidebarProvider and the edge-peek in
      // SidebarContent, neither of which reads this flag. SidebarCollapseButton
      // above replaces the trigger this removes from the navbar's right cluster.
      // `footer` pins Chain info, Audit reports and Contribute under every
      // section tree. They were `pages` link entries in all eleven roots until
      // FS-2716; a link entry is a real tree node, so it stole those pages'
      // sidebar root. The footer slot renders after the tree and outside it.
      sidebar={{ collapsible: false, footer: SidebarResourceLinks }}
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
