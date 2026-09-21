'use client';

import type { Separator } from 'fumadocs-core/page-tree';
import { SidebarItem, SidebarSeparator, useFolderDepth } from 'fumadocs-ui/components/sidebar/base';

import type { NavigationReference } from '@/lib/docs-navigation';

/** Render cross-section links without adding duplicate page nodes to the navigation tree. */
export function SidebarNavigationReference({ item }: { item: Separator }) {
  const depth = useFolderDepth();
  if ('url' in item) {
    const { url } = item as NavigationReference;
    return (
      <SidebarItem
        href={url}
        external={url.startsWith('https://')}
        className="relative flex items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground wrap-anywhere transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
        style={{ paddingInlineStart: `calc(${2 + 3 * depth} * var(--spacing))` }}
      >
        {item.name}
      </SidebarItem>
    );
  }
  return <SidebarSeparator>{item.name}</SidebarSeparator>;
}
