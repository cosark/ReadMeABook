/**
 * Component: Request Stop Guard
 * Documentation: documentation/backend/services/jobs.md
 *
 * A user can cancel (or delete) a request while its download is still being
 * monitored. Background jobs must then stop: never import the download and
 * never flip the request back to 'failed'.
 */

import { prisma } from '../db';

export type RequestStopReason = 'cancelled' | 'deleted' | 'missing';

/**
 * Why background work for this request must stop, or null to carry on.
 * A row that no longer exists counts as stopped.
 */
export async function getRequestStopReason(requestId: string): Promise<RequestStopReason | null> {
  const request = await prisma.request.findUnique({
    where: { id: requestId },
    select: { status: true, deletedAt: true },
  });

  if (!request) return 'missing';
  if (request.deletedAt) return 'deleted';
  if (request.status === 'cancelled') return 'cancelled';
  return null;
}

/**
 * Mark the request failed in one conditional write that skips cancelled and
 * deleted requests, so a cancel landing at the same moment is never
 * overwritten. Returns true when the request was marked failed.
 */
export async function markRequestFailedUnlessStopped(
  requestId: string,
  errorMessage: string
): Promise<boolean> {
  const { count } = await prisma.request.updateMany({
    where: { id: requestId, deletedAt: null, status: { not: 'cancelled' } },
    data: {
      status: 'failed',
      errorMessage,
      updatedAt: new Date(),
    },
  });
  return count > 0;
}
