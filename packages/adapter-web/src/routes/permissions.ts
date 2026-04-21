import { Router as expressRouter, type Request, type Response } from 'express';
import type { RouterHandle } from '@rederjs/core/adapter';

export interface PermissionsRouteDeps {
  router: RouterHandle;
  respondent: string;
}

export function createPermissionsRouter(
  deps: PermissionsRouteDeps,
): ReturnType<typeof expressRouter> {
  const r = expressRouter();

  r.post('/sessions/:id/permissions/:requestId', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { behavior?: unknown; persistent?: unknown };
    if (body.behavior !== 'allow' && body.behavior !== 'deny') {
      res.status(400).json({ error: "behavior must be 'allow' or 'deny'" });
      return;
    }
    await deps.router.ingestPermissionVerdict({
      requestId: req.params['requestId']!,
      behavior: body.behavior,
      respondent: deps.respondent,
      ...(body.persistent === true ? { persistent: true } : {}),
    });
    res.status(202).json({ accepted: true });
  });

  return r;
}
