import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ASCClient } from '../client.js';
import { ASCError } from '../errors.js';
import { BuildIdSchema } from '../schemas.js';

// BuildBetaNotification is a fire-and-forget POST: it tells Apple "notify
// every tester who has access to this build that it's available". There is
// no list/get/delete — the created resource is just an acknowledgment
// (id + type, no attributes).
//
// Contract gotcha (pinned in tests): BuildBetaNotificationCreateRequest has
// NO attributes block at all — the data object carries type + relationships
// only. This is stricter than the v0.15 no-attrs-block OMISSION cases (where
// attrs were optional); here the shape never had attributes to begin with.
// Apple rejects a stray `attributes: {}`.
//
// Relationship to autoNotifyEnabled: builds whose buildBetaDetail has
// autoNotifyEnabled=true notify testers automatically when the build goes
// live. This tool is the MANUAL trigger — for builds with autoNotify off,
// or to re-ping testers about an existing build.

interface JSONAPIBody {
  data: {
    type: string;
    relationships: Record<string, unknown>;
  };
}

export function buildBuildBetaNotificationCreateBody(buildId: string): JSONAPIBody {
  return {
    data: {
      type: 'buildBetaNotifications',
      relationships: {
        build: { data: { type: 'builds', id: buildId } },
      },
    },
  };
}

function formatASCError(err: unknown): string {
  if (err instanceof ASCError) {
    const detail =
      typeof err.details === 'string' ? err.details : JSON.stringify(err.details, null, 2);
    return `${err.message}\n\n${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerBuildBetaNotifications(server: McpServer, client: ASCClient): void {
  server.registerTool(
    'asc_post_build_beta_notification',
    {
      title: 'Notify testers about a build',
      description:
        'POST /v1/buildBetaNotifications — send the "new build available" TestFlight notification to every tester who has access to the build. Fire-and-forget: Apple returns an acknowledgment resource with no attributes, and there is no way to list or revoke a sent notification. Use for builds where autoNotifyEnabled is off (see asc_patch_build_beta_detail), or to re-ping testers. The build must be in VALID processingState and already distributed to at least one group/tester.',
      inputSchema: z.object({
        buildId: BuildIdSchema,
      }),
    },
    async ({ buildId }) => {
      const body = buildBuildBetaNotificationCreateBody(buildId);
      try {
        const data = await client.request<unknown>('/v1/buildBetaNotifications', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Sent tester notification for build ${buildId}.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatASCError(err) }], isError: true };
      }
    },
  );
}
