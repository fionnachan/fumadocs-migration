import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import type { ReactNode } from 'react';

import { SidebarCollapseButton } from '@/components/sidebar-collapse-button';
import { SidebarResourceLinks } from '@/components/sidebar-resource-links';
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
      // `footer` pins Chain info, Audit reports and Contribute under every
      // section tree. They were `pages` link entries in all eleven roots until
      // FS-2716; a link entry is a real tree node, so it stole those pages'
      // sidebar root. The footer slot renders after the tree and outside it.
      sidebar={{ collapsible: false, footer: SidebarResourceLinks }}
      tree={source.pageTree}
      // No root switcher. Fumadocs would otherwise render a dropdown above the tree listing every
      // `"root": true` folder (twelve here), which is a second copy of the navbar's section list
      // that also names sections the navbar deliberately leaves out, and disagrees with it about
      // what the sections are (the navbar groups Build apps, Stylus and Essentials under one menu).
      // The navbar chooses the section; the sidebar shows that section's tree, as the Docusaurus
      // site did. Roots still matter: `TreeContextProvider` picks the tree from the last root on
      // the page's path whether or not the switcher renders, which is what `nav:check` guards.
      tabs={false}
    >
      {children}
    </DocsLayout>
  );
}
