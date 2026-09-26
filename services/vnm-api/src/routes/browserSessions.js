/**
 * Browser-play session routes (real Kasm launch path).
 *
 *   POST   /library/titles/:titleId/browser-session   launch for the caller
 *   GET    /browser-sessions/:sessionId               status (owner or admin)
 *   DELETE /browser-sessions/:sessionId               terminate (owner or admin)
 *
 * Thin transport over services/browserSessionService.js. No Kasm credentials or
 * raw session tokens leave the server; a RUNNING status may include a connect
 * URL because the browser must navigate to it.
 */

import {
  BrowserSessionError,
  launchTitleBrowserSession,
  refreshBrowserSessionStatus,
  terminateBrowserSession,
} from '../services/browserSessionService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Translate a service error into a stable HTTP response. */
function sendError(reply, err) {
  if (err instanceof BrowserSessionError) {
    return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
  }
  if (err?.code === 'KASM_API_ERROR') {
    return reply.code(502).send({ error: { code: 'KASM_API_ERROR', message: err.message } });
  }
  if (err?.code === 'KASM_TRANSPORT_ERROR') {
    return reply.code(502).send({ error: { code: 'KASM_UNAVAILABLE', message: 'Kasm is not reachable.' } });
  }
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: err?.message || 'Unexpected error.' } });
}

const requireUser = (request, reply) => {
  const userId = request.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return null;
  }
  return userId;
};

export default async function browserSessionsRoutes(fastify) {
  const manifestRoot = fastify.manifestRoot;
  const goldenRoot = fastify.goldenRoot;
  const userRuntimeRoot = fastify.userRuntimeRoot;
  const allowedRunnerImages = fastify.allowedRunnerImages;
  const lockRegistry = fastify.kasmLockRegistry;
  const publicBaseUrl = process.env.KASM_PUBLIC_BASE_URL || null;

  fastify.post('/library/titles/:titleId/browser-session', async (request, reply) => {
    const userId = requireUser(request, reply);
    if (!userId) return;

    const { titleId } = request.params;
    if (!UUID_RE.test(titleId)) {
      return reply.code(400).send({ error: { code: 'INVALID_TITLE_ID', message: 'titleId must be a UUID.' } });
    }

    try {
      return await launchTitleBrowserSession({
        prisma: fastify.prisma,
        kasmClient: fastify.kasmClient,
        titleId,
        userId,
        goldenRoot,
        manifestRoot,
        userRuntimeRoot,
        allowedRunnerImages,
        lockRegistry,
        prepareRuntime: fastify.prepareRuntime,
        publicBaseUrl,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/browser-sessions/:sessionId', async (request, reply) => {
    const userId = requireUser(request, reply);
    if (!userId) return;

    const { sessionId } = request.params;
    if (!UUID_RE.test(sessionId)) {
      return reply.code(400).send({ error: { code: 'INVALID_SESSION_ID', message: 'sessionId must be a UUID.' } });
    }

    try {
      return await refreshBrowserSessionStatus({
        prisma: fastify.prisma,
        kasmClient: fastify.kasmClient,
        sessionId,
        user: request.user,
        publicBaseUrl,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.delete('/browser-sessions/:sessionId', async (request, reply) => {
    const userId = requireUser(request, reply);
    if (!userId) return;

    const { sessionId } = request.params;
    if (!UUID_RE.test(sessionId)) {
      return reply.code(400).send({ error: { code: 'INVALID_SESSION_ID', message: 'sessionId must be a UUID.' } });
    }

    try {
      return await terminateBrowserSession({
        prisma: fastify.prisma,
        kasmClient: fastify.kasmClient,
        sessionId,
        user: request.user,
        userRuntimeRoot,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
