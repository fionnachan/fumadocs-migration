import type { Selection } from 'd3-selection';
import { useCallback, useEffect, useRef } from 'react';

import { buildTreeData, formatRangeText, resolveLevelType, shortHex } from './edgeChallengeLogic';
import type { AppliedState, LevelGroup, LevelMeta, TreeNode } from './types';

interface D3EdgeTreeProps {
  group: LevelGroup;
  state: AppliedState;
  levelMeta: LevelMeta;
  collapsedSet: Set<string>;
  onSelectNode: (rangeKey: string) => void;
  onToggleNode: (rangeKey: string) => void;
}

export default function D3EdgeTree({
  group,
  state,
  levelMeta,
  collapsedSet,
  onSelectNode,
  onToggleNode,
}: D3EdgeTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const d3Ref = useRef<any>(null);
  const zoomStateRef = useRef<any>(null);

  const renderTree = useCallback(
    async (isCancelled: () => boolean) => {
      const container = containerRef.current;
      if (!container) return;

      // Only the five functions this file calls, each from its own package. Importing `d3` pulls the
      // whole toolkit into the chunk, d3-geo and all, for a tree that needs a layout, a selection, a
      // zoom behaviour and a link generator.
      const [{ select }, { hierarchy, tree }, { linkHorizontal }, { zoom }] = await Promise.all([
        import('d3-selection'),
        import('d3-hierarchy'),
        import('d3-shape'),
        import('d3-zoom'),
      ]);

      // The await above means a second render can start while this one is still loading. Without this
      // check both would pass the `svg.empty()` test below and append their own <svg>.
      if (isCancelled()) return;

      if (group.rootKeys.length === 0) {
        container.innerHTML = '<div class="ecf-tree-empty">No nodes</div>';
        return;
      }

      if (container.querySelector('.ecf-tree-empty')) {
        container.innerHTML = '';
      }

      const treeData = buildTreeData(group, collapsedSet);
      const root = hierarchy(treeData, (d: TreeNode) => d.children);
      const nodeCount = root.descendants().length;
      // Tighter spacing for smaller trees, more room for large ones
      const vSpacing = nodeCount > 20 ? 140 : 160;
      const hSpacing = 360;
      const nodeSize: [number, number] = [vSpacing, hSpacing];
      const treeLayout = tree<TreeNode>().nodeSize(nodeSize);
      treeLayout(root as any);

      let x0 = Infinity;
      let x1 = -Infinity;
      (root as any).each((d: any) => {
        if (d.x < x0) x0 = d.x;
        if (d.x > x1) x1 = d.x;
      });

      const margin = { top: 24, right: 30, bottom: 24, left: 30 };
      const panelWidth = container.clientWidth || 360;
      const height = Math.max(200, x1 - x0 + margin.top + margin.bottom);
      const viewWidth = Math.max(
        panelWidth,
        root.height * nodeSize[1] + margin.left + margin.right,
      );

      (root as any).each((d: any) => {
        d.x = d.x - x0 + margin.top;
        d.y = d.y + margin.left;
      });

      // Manage SVG lifecycle
      let svg = select(container).select<SVGSVGElement>('svg');
      let g: Selection<SVGGElement, unknown, null, undefined>;

      if (svg.empty()) {
        svg = select(container).append('svg');
        g = svg.append('g');
        const zoomBehavior = zoom<SVGSVGElement, unknown>()
          .scaleExtent([0.2, 2])
          .on('zoom', (event) => {
            zoomStateRef.current = event.transform;
            g.attr('transform', event.transform as any);
          });
        svg.call(zoomBehavior);
        d3Ref.current = { svg, g, zoom: zoomBehavior };
      } else {
        g = d3Ref.current?.g || svg.select('g');
      }

      svg
        .attr('width', viewWidth)
        .attr('height', height)
        .attr('viewBox', `0 0 ${viewWidth} ${height}`);
      if (zoomStateRef.current) {
        g.attr('transform', zoomStateRef.current);
      }
      g.selectAll('*').remove();

      const linkPath = linkHorizontal<any, any>()
        .x((d) => d.y)
        .y((d) => d.x);

      g.append('g')
        .selectAll('path')
        .data(root.links())
        .join('path')
        .attr('class', 'ecf-link')
        .attr('d', linkPath as any);

      const nodeWidth = 280;
      const textLineHeight = 15;
      const textPadding = 10;

      const indexToLabel = (index: number) => {
        if (index < 26) return String.fromCharCode(65 + index);
        return `E${index + 1}`;
      };

      const buildNodeLines = (nodeData: TreeNode) => {
        if (!nodeData?.rangeKey) return [];
        const lt = resolveLevelType(nodeData.level, levelMeta);
        const levelText = lt ?? (nodeData.level !== '-' ? `L${nodeData.level}` : 'Level ?');
        const rangeText = formatRangeText(nodeData.startHeight ?? null, nodeData.endHeight ?? null);
        const lines = [`${levelText} range ${rangeText}`, `hasRival: ${nodeData.hasRival}`];
        const edges = nodeData.edges || [];
        const displayEdges = edges.slice(0, 3);
        displayEdges.forEach((edge, idx) => {
          const label = indexToLabel(idx);
          const rivalMark = edge.hasRival ? ' (rival)' : '';
          lines.push(`${label}: ${shortHex(edge.id, 4, 2)}${rivalMark}`);
        });
        if (edges.length > displayEdges.length) {
          lines.push(`... +${edges.length - displayEdges.length}`);
        }
        return lines;
      };

      const nodeHeight = (d: any) => {
        const lineCount = Math.max(buildNodeLines(d.data).length, 1);
        return lineCount * textLineHeight + textPadding * 2;
      };

      const node = g
        .append('g')
        .selectAll('g')
        .data(root.descendants())
        .join('g')
        .attr('class', (d: any) => {
          if (!d.data.rangeKey) return 'ecf-node';
          const classes = ['ecf-node'];
          if (d.data.edges?.some((edge: any) => edge.id === state.activeEdgeId)) {
            classes.push('ecf-node--active');
          }
          if (d.data.hasRival) classes.push('ecf-node--hasRival');
          if (d.data.bisected) classes.push('ecf-node--bisected');
          if (d.data.ospConfirmed) classes.push('ecf-node--osp');
          return classes.join(' ');
        })
        .attr('transform', (d: any) => `translate(${d.y},${d.x})`)
        .style('cursor', (d: any) => (d.data.rangeKey ? 'pointer' : 'default'))
        .on('click', (event: MouseEvent, d: any) => {
          if (!d.data.rangeKey) return;
          event.stopPropagation();
          onSelectNode(d.data.rangeKey);
        })
        .on('dblclick', (event: MouseEvent, d: any) => {
          if (!d.data.rangeKey) return;
          event.stopPropagation();
          onToggleNode(d.data.rangeKey);
        });

      node
        .filter((d: any) => d.data.rangeKey)
        .append('rect')
        .attr('x', -nodeWidth / 2)
        .attr('y', (d: any) => -nodeHeight(d) / 2)
        .attr('width', nodeWidth)
        .attr('height', (d: any) => nodeHeight(d));

      node
        .filter((d: any) => d.data.rangeKey)
        .append('text')
        .attr('text-anchor', 'middle')
        .each(function (this: SVGTextElement, d: any) {
          const lines = buildNodeLines(d.data);
          const h = nodeHeight(d);
          const textStartY = -h / 2 + textPadding + textLineHeight - 2;
          const text = select(this);
          text.attr('y', textStartY);
          lines.forEach((line, idx) => {
            text
              .append('tspan')
              .attr('x', 0)
              .attr('dy', idx === 0 ? 0 : textLineHeight)
              .attr('class', idx === 0 ? null : 'ecf-node-label')
              .text(line);
          });
        });

      node
        .filter((d: any) => d.data.rangeKey && (d.children?.length || d.data._children?.length))
        .append('text')
        .attr('x', nodeWidth / 2 - 10)
        .attr('y', (d: any) => -nodeHeight(d) / 2 + 12)
        .attr('text-anchor', 'end')
        .attr('class', 'ecf-node-label')
        .text((d: any) => (collapsedSet.has(d.data.rangeKey) ? '+' : '-'));
    },
    [group, state, levelMeta, collapsedSet, onSelectNode, onToggleNode],
  );

  useEffect(() => {
    let cancelled = false;
    void renderTree(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [renderTree]);

  return <div ref={containerRef} className="ecf-tree-canvas" />;
}
