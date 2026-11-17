import { FirestoreService } from '../services/firestoreService.js';

let mockReqUser: any = null;
jest.mock('../middleware/auth.js', () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    req.user = mockReqUser;
    next();
  },
  requireAuth: (req: any, res: any, next: any) => {
    if (!mockReqUser) return res.status(401).json({ error: 'Unauthorized' });
    req.user = mockReqUser;
    next();
  }
}));

import messagesRouter from '../routes/messages.js';

async function invokeGetSessionRoute(sessionId: string) {
  const layer = (messagesRouter as any).stack.find(
    (s: any) => s.route?.path === '/session/:sessionId' && s.route?.methods?.get
  );
  if (!layer) {
    throw new Error('GET /session/:sessionId route not found');
  }

  const req: any = {
    params: { sessionId },
    headers: {},
    query: {},
    user: mockReqUser
  };

  let statusCode = 200;
  let jsonBody: any = null;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      jsonBody = payload;
      return this;
    }
  };

  const handlers = layer.route.stack.map((s: any) => s.handle);
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => {
      nextCalled = true;
    });
    if (!nextCalled && jsonBody !== null) {
      break;
    }
  }

  return { status: statusCode, body: jsonBody };
}

describe('GET /api/messages/session/:sessionId job & session hydration', () => {
  beforeEach(() => {
    mockReqUser = { uid: 'user-1', role: 'user' };
    jest.restoreAllMocks();
  });

  it('returns 404 when neither session nor markingJob exists', async () => {
    jest.spyOn(FirestoreService, 'getUnifiedSession').mockResolvedValue(null);
    jest.spyOn(FirestoreService, 'getMarkingJob').mockResolvedValue(null);

    const res = await invokeGetSessionRoute('missing-id');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('enforces ownership on job even when session does not exist', async () => {
    mockReqUser = { uid: 'other-user', role: 'user' };
    jest.spyOn(FirestoreService, 'getUnifiedSession').mockResolvedValue(null);
    jest.spyOn(FirestoreService, 'getMarkingJob').mockResolvedValue({
      id: 'sub-1',
      userId: 'user-1',
      status: 'processing',
      updatedAt: Date.now()
    });

    const res = await invokeGetSessionRoute('sub-1');
    expect(res.status).toBe(403);
  });

  it('enforces ownership on session', async () => {
    mockReqUser = null;
    jest.spyOn(FirestoreService, 'getUnifiedSession').mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      messages: []
    });
    jest.spyOn(FirestoreService, 'getMarkingJob').mockResolvedValue(null);

    const res = await invokeGetSessionRoute('sess-1');
    expect(res.status).toBe(403);
  });

  it('returns status: processing when job is fresh and processing', async () => {
    const progressData = {
      currentStepDescription: 'Marking...',
      allSteps: ['Input Validation', 'Marking'],
      currentStepIndex: 1,
      isComplete: false
    };
    jest.spyOn(FirestoreService, 'getUnifiedSession').mockResolvedValue(null);
    jest.spyOn(FirestoreService, 'getMarkingJob').mockResolvedValue({
      id: 'sub-1',
      userId: 'user-1',
      status: 'processing',
      isRemark: false,
      progressData,
      startedAt: Date.now() - 5000,
      updatedAt: Date.now()
    });

    const res = await invokeGetSessionRoute('sub-1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processing');
    expect(res.body.progressData).toEqual(progressData);
  });

  it('skips status: failed when job.isRemark is true and session exists', async () => {
    const session = {
      id: 'sess-1',
      userId: 'user-1',
      messages: [{ id: 'm1', role: 'assistant', content: 'Valid prior marking' }]
    };
    jest.spyOn(FirestoreService, 'getUnifiedSession').mockResolvedValue(session);
    jest.spyOn(FirestoreService, 'getMarkingJob').mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      status: 'failed',
      isRemark: true,
      error: 'Invalid scheme',
      updatedAt: Date.now()
    });

    const res = await invokeGetSessionRoute('sess-1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.session.id).toBe('sess-1');
  });

  it('returns status: failed when fresh non-remark job failed', async () => {
    jest.spyOn(FirestoreService, 'getUnifiedSession').mockResolvedValue(null);
    jest.spyOn(FirestoreService, 'getMarkingJob').mockResolvedValue({
      id: 'sub-2',
      userId: 'user-1',
      status: 'failed',
      isRemark: false,
      error: 'Credit exhausted',
      credits_exhausted: true,
      updatedAt: Date.now()
    });

    const res = await invokeGetSessionRoute('sub-2');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.credits_exhausted).toBe(true);
  });

  it('returns status: completed with fallbackResult when session is not persisted', async () => {
    mockReqUser = null;
    const fallbackResult = { success: true, sessionId: 'sub-guest', aiMessage: { id: 'ai-1', content: 'Done' } };
    jest.spyOn(FirestoreService, 'getUnifiedSession').mockResolvedValue(null);
    jest.spyOn(FirestoreService, 'getMarkingJob').mockResolvedValue({
      id: 'sub-guest',
      userId: null,
      status: 'completed',
      fallbackResult,
      updatedAt: Date.now()
    });

    const res = await invokeGetSessionRoute('sub-guest');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.fallbackResult).toEqual(fallbackResult);
  });
});
