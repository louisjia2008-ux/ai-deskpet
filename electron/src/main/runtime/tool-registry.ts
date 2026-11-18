import { z } from 'zod';
import { ToolFailure } from './tool-failure';

import type { RiskLevel } from '../../shared';

export interface ToolContext {
  runId: string;
  taskId: string;
  signal: AbortSignal;
  /** Host-owned revocable lease; model request fields cannot supply it. */
  assertAuthorized?: () => void;
}

export interface ToolDefinition {
  id: string;
  title: string;
  description?: string;
  capabilityId: string;
  risk: RiskLevel;
  sideEffect: boolean;
  inputSchema: z.ZodType<unknown>;
  /** A JSON Schema declared to the model in place of one derived from `inputSchema`. */
  parameters?: Record<string, unknown>;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface ToolDescriptor extends Pick<ToolDefinition, 'id' | 'title' | 'description' | 'capabilityId' | 'risk' | 'sideEffect'> {
  parameters: Record<string, unknown>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #sources: Array<() => readonly ToolDefinition[]> = [];

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool ${tool.id} is already registered.`);
    }
    this.#tools.set(tool.id, tool);
  }

  /** Tools whose set follows stored state, read again on every lookup. Fixed tools win on an ID clash. */
  registerSource(source: () => readonly ToolDefinition[]): void {
    this.#sources.push(source);
  }

  #all(): ToolDefinition[] {
    const dynamic = this.#sources.flatMap(source => source()).filter(tool => !this.#tools.has(tool.id));
    return [...this.#tools.values(), ...dynamic.filter((tool, index) => dynamic.findIndex(item => item.id === tool.id) === index)];
  }

  get(id: string): ToolDefinition {
    const tool = this.#tools.get(id) ?? this.#all().find(item => item.id === id);
    if (tool === undefined) {
      throw new ToolFailure('tool.unknown');
    }
    return tool;
  }

  describe(): ToolDescriptor[] {
    return this.#all().map(({ id, title, description, capabilityId, risk, sideEffect, inputSchema, parameters: declared }) => {
      const parameters = declared ? structuredClone(declared) : z.toJSONSchema(inputSchema, { target: 'draft-7' }) as Record<string, unknown>;
      delete parameters.$schema;
      return { id, title, ...(description ? { description } : {}), capabilityId, risk, sideEffect, parameters };
    });
  }
}
