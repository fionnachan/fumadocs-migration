'use client';

import dynamic from 'next/dynamic';

/**
 * Lazy boundary for the Timeboost auction diagram.
 *
 * The artwork is a 2300-line inline SVG that one page renders, so `next/dynamic` keeps it out of the
 * bundle every other docs page loads. Server rendering stays on: the diagram is static markup until
 * a reader opens a step.
 */
const FlowChartImpl = dynamic(() => import('./FlowChart').then((mod) => mod.FlowChart));

export function FlowChart() {
  return <FlowChartImpl role="img" aria-label="Timeboost centralized auction flow" />;
}
