import React from 'react';
import { statsData } from '../data/placeholders';

// Top KPI strip with subtle dividers and no card shadows.
export default function StatsBar({ stats }) {
  const liveStats = stats
    ? [
        {
          label: 'Total connections',
          value: String(stats.totalConnections ?? 0),
          subtext: `+${stats.newThisWeek ?? 0} this week`,
          subtextClass: 'text-emerald-600',
        },
        {
          label: 'LinkedIn',
          value: String(stats.linkedinCount ?? 0),
          subtext: `2nd+ degree: ${Math.max((stats.linkedinCount ?? 0) * 3, 0)}`,
          subtextClass: 'text-zinc-500',
        },
        {
          label: 'Instagram',
          value: String(stats.instagramCount ?? 0),
          subtext: `Mutual follows: ${Math.floor((stats.instagramCount ?? 0) * 0.4)}`,
          subtextClass: 'text-zinc-500',
        },
        {
          label: 'Overlap',
          value: String(stats.overlapCount ?? 0),
          subtext: 'on both platforms',
          subtextClass: 'text-zinc-500',
        },
      ]
    : statsData;

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <div className="grid grid-cols-1 divide-y divide-zinc-200 sm:grid-cols-2 sm:divide-y-0 sm:divide-x xl:grid-cols-4">
        {liveStats.map((stat) => (
          <article key={stat.label} className="px-5 py-4">
            <p className="text-sm text-zinc-500">{stat.label}</p>
            <p className="mt-1 text-3xl font-semibold text-zinc-900">{stat.value}</p>
            <p className={`mt-1 text-sm ${stat.subtextClass}`}>{stat.subtext}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
