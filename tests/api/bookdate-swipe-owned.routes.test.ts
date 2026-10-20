/**
 * Component: BookDate Swipe Library Check Tests (#287)
 * Documentation: documentation/features/bookdate-prd.md
 *
 * A right swipe runs the same library check as POST /api/requests (real findPlexMatch over
 * plex_library): a book already in the library is never requested.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

let authRequest: any;
const prismaMock = createPrismaMock();
const requireAuthMock = vi.hoisted(() => vi.fn());
const audibleServiceMock = vi.hoisted(() => ({
  getAudiobookDetails: vi.fn(),
}));
const configServiceGet = vi.hoisted(() => vi.fn());
const jobQueueMock = vi.hoisted(() => ({
  addSearchJob: vi.fn(),
  addNotificationJob: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock, requireAdmin: vi.fn() }));
vi.mock('@/lib/integrations/audible.service', () => ({ getAudibleService: () => audibleServiceMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({ get: configServiceGet }) }));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => jobQueueMock }));

const RECOMMENDATION = {
  id: 'rec-owned',
  userId: 'user-1',
  title: 'Owned Book',
  author: 'Owned Author',
  narrator: 'Owned Narrator',
  audnexusAsin: 'B0OWNED001',
};

async function swipeRight() {
  authRequest.json.mockResolvedValue({ recommendationId: RECOMMENDATION.id, action: 'right', markedAsKnown: false });
  prismaMock.bookDateRecommendation.findUnique.mockResolvedValueOnce({ ...RECOMMENDATION } as any);
  prismaMock.bookDateSwipe.create.mockResolvedValueOnce({} as any);
  const { POST } = await import('@/app/api/bookdate/swipe/route');
  const response = await POST({} as any);
  return { status: response.status, payload: await response.json() };
}

describe('BookDate swipe: library check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobQueueMock.addSearchJob.mockResolvedValue(undefined);
    jobQueueMock.addNotificationJob.mockResolvedValue(undefined);
    configServiceGet.mockResolvedValue(null);
    audibleServiceMock.getAudiobookDetails.mockResolvedValue(null);
    authRequest = { user: { id: 'user-1', role: 'admin' }, json: vi.fn() };
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler(authRequest));
  });

  it('creates no request when the ASIN is already in the library', async () => {
    prismaMock.plexLibrary.findMany.mockResolvedValue([
      { plexGuid: 'abs-item-1', plexRatingKey: 'abs-item-1', title: 'Owned Book', author: 'Owned Author', asin: 'B0OWNED001' },
    ]);

    const { status, payload } = await swipeRight();

    expect(status).toBe(200);
    expect(payload).toEqual({ success: true, action: 'right', markedAsKnown: false, alreadyInLibrary: true });
    expect(prismaMock.bookDateSwipe.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.plexLibrary.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ asin: 'B0OWNED001' }, { plexGuid: { contains: 'B0OWNED001' } }] },
    }));
    expect(prismaMock.request.create).not.toHaveBeenCalled();
    expect(prismaMock.audiobook.create).not.toHaveBeenCalled();
    expect(audibleServiceMock.getAudiobookDetails).not.toHaveBeenCalled();
    expect(jobQueueMock.addSearchJob).not.toHaveBeenCalled();
  });

  it('still creates the request when the book is not in the library', async () => {
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    prismaMock.audiobook.findFirst.mockResolvedValueOnce(null);
    prismaMock.audiobook.create.mockResolvedValueOnce({ id: 'ab-1', title: 'Owned Book', author: 'Owned Author', audibleAsin: 'B0OWNED001' } as any);
    prismaMock.request.findFirst.mockResolvedValueOnce(null);
    prismaMock.user.findUnique.mockResolvedValueOnce({ role: 'admin', autoApproveRequests: null, plexUsername: 'u' } as any);
    prismaMock.request.create.mockResolvedValueOnce({ id: 'req-1' } as any);

    const { status, payload } = await swipeRight();

    expect(status).toBe(200);
    expect(payload.alreadyInLibrary).toBe(false);
    expect(prismaMock.request.create).toHaveBeenCalledTimes(1);
    expect(jobQueueMock.addSearchJob).toHaveBeenCalledTimes(1);
  });

  it('records the swipe but creates no request when the library check fails', async () => {
    prismaMock.plexLibrary.findMany.mockRejectedValue(new Error('db down'));

    const { status, payload } = await swipeRight();

    expect(status).toBe(200);
    expect(payload).toMatchObject({ success: true, alreadyInLibrary: false });
    expect(prismaMock.bookDateSwipe.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.request.create).not.toHaveBeenCalled();
  });
});
