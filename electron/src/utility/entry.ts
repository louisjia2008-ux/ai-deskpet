import { OpenAICompatibleAdapter } from '../main/providers';
import { providerFailureCode } from '../shared/provider-errors';
import { providerUtilityCommandSchema } from './provider-protocol';
import type { ProviderUtilityResponse } from './provider-protocol';
import { providerNetworkFetch } from './provider-network';

const port = process.parentPort;
if (port === null) throw new Error('DeskPet provider utility requires an Electron parent port.');

const controllers = new Map<string, AbortController>();
const post = (response: ProviderUtilityResponse): void => port.postMessage(response);

port.on('message', (messageEvent) => {
  void (async () => {
    const parsed = providerUtilityCommandSchema.safeParse(messageEvent.data);
    if (!parsed.success) return;
    const command = parsed.data;
    if (command.kind === 'provider:cancel') {
      controllers.get(command.requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    controllers.set(command.requestId, controller);
    try {
      let lastProgress = 0;
      const adapter = new OpenAICompatibleAdapter(command.credentials, providerNetworkFetch, undefined, () => {
        if (command.kind === 'provider:chat' && Date.now() - lastProgress >= 1_000) {
          lastProgress = Date.now();
          post({ version: 1, kind: 'provider:progress', requestId: command.requestId });
        }
      });
      if (command.kind === 'provider:models') {
        post({ version: 1, kind: 'provider:models-result', requestId: command.requestId, models: await adapter.listModels(controller.signal) });
      } else if (command.kind === 'provider:inspect-model') {
        post({ version: 1, kind: 'provider:inspect-model-result', requestId: command.requestId, inspection: await adapter.inspectModel(command.model, controller.signal) });
      } else {
        const providerRequest = {
          model: command.request.model,
          ...(command.request.ollamaNumCtx === undefined ? {} : { ollamaNumCtx: command.request.ollamaNumCtx }),
          ...(command.request.wireProtocol === undefined ? {} : { wireProtocol: command.request.wireProtocol }),
          ...(command.request.executionMode === undefined ? {} : { executionMode: command.request.executionMode }),
          messages: command.request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
            ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
            ...(message.toolThought === undefined ? {} : { toolThought: message.toolThought }),
            ...(message.responseItems === undefined ? {} : { responseItems: message.responseItems }),
          })),
          ...(command.request.tools === undefined ? {} : { tools: command.request.tools }),
          ...(command.request.temperature === undefined ? {} : { temperature: command.request.temperature }),
          ...(command.request.reasoningEffort === undefined ? {} : { reasoningEffort: command.request.reasoningEffort }),
          ...(command.request.maxOutputTokens === undefined ? {} : { maxOutputTokens: command.request.maxOutputTokens }),
          ...(command.request.outputTokenParameter === undefined ? {} : { outputTokenParameter: command.request.outputTokenParameter }),
          ...(command.request.contextBudget === undefined ? {} : { contextBudget: command.request.contextBudget }),
          ...(command.request.identity === undefined ? {} : { identity: command.request.identity }),
        };
        for await (const event of adapter.streamChat(providerRequest, controller.signal)) {
          post({ version: 1, kind: 'provider:event', requestId: command.requestId, event });
        }
        post({ version: 1, kind: 'provider:complete', requestId: command.requestId });
      }
    } catch (error) {
      const errorCode = error instanceof Error && error.message === 'job.toolsForbidden'
        ? 'job.toolsForbidden' : providerFailureCode(error, controller.signal.aborted ? 'provider.cancelled' : 'provider.failed');
      post({ version: 1, kind: 'provider:error', requestId: command.requestId, errorCode });
    } finally {
      controllers.delete(command.requestId);
    }
  })();
});
