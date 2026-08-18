import React from 'react';
import { Link, Text } from '../ink.js';
import type { PrReviewState } from '../utils/ghPrStatus.js';
type Props = {
  number: number;
  url: string;
  reviewState?: PrReviewState;
  bold?: boolean;
  // CC 2.1.234: 'mr' renders the GitLab merge-request form ("MR !N");
  // anything else renders the GitHub pull-request form ("PR #N").
  kind?: 'pr' | 'mr';
};
export function PrBadge(t0) {
  const { number, url, reviewState, bold, kind } = t0;
  const statusColor = getPrStatusColor(reviewState);
  const isMr = kind === 'mr';
  const prefix = isMr ? 'MR' : 'PR';
  const symbol = isMr ? '!' : '#';
  const label = <Text color={statusColor} dimColor={!statusColor && !bold} bold={bold}>{symbol}{number}</Text>;
  return <Text><Text dimColor={!bold}>{prefix}</Text>{" "}<Link url={url} fallback={label}><Text color={statusColor} dimColor={!statusColor && !bold} underline={true} bold={bold}>{symbol}{number}</Text></Link></Text>;
}
function getPrStatusColor(state?: PrReviewState): 'success' | 'error' | 'warning' | 'merged' | undefined {
  switch (state) {
    case 'approved':
      return 'success';
    case 'changes_requested':
      return 'error';
    case 'pending':
      return 'warning';
    case 'merged':
      return 'merged';
    default:
      return undefined;
  }
}
