import { AgentManager } from '../services/agentManager.js';
import { Agent } from '../services/agentRegistry.js';
import axios from 'axios';
import { readMcpServers } from '../services/mcpServerService.js';
import { ApolloContext } from './server.js';
import { JSONObjectResolver } from 'graphql-scalars'; // Import JSONObjectResolver directly
import { GraphQLError } from 'graphql'; // Import GraphQLError

// Define a type alias for JSONObject for clarity
type JSONObject = ReturnType<typeof JSONObjectResolver['serialize']>;

// Define the structure for McpServerConfig to match the schema
interface McpServerConfig {
  name: string;
  timeout: number;
  command: string;
  args: string[];
  transportType: string;
  env: { [key: string]: string };
  tools: any[]; // Add tools field
  resources: string[]; // Add resources field
}

interface UpdateAgentInput {
  name?: string;
  description?: string;
  systemPrompt?: string;
  providerType?: 'LMSTUDIO' | 'GOOGLE'; // Match the enum values
  environmentVariables?: JSONObject;
  executionMode?: 'BARE_HOST' | 'DOCKERIZED'; // Add to UpdateAgentInput as well for potential future updates
  scopePath?: string; // Add to UpdateAgentInput
}

export const kaAgentResolvers = {
  Query: {
    agents: (_parent: any, _args: any, context: ApolloContext, _info: any): Agent[] => {
            return context.agentManager.getAgents();
          },
          // Resolver to fetch a single agent by ID
          agent: (_parent: any, { id }: { id: string }, context: ApolloContext, _info: any): Agent | undefined => {
            console.log(`[Resolver agent] Fetching agent with ID: ${id}`);
            const agent = context.agentManager.getAgents().find((a: Agent) => a.id === id);
            if (!agent) {
              console.warn(`[Resolver agent] Agent with ID ${id} not found.`);
            } else {
              console.log(`[Resolver agent] Found agent: ${agent.name}`);
            }
            return agent;
          },
          agentLogs: (_parent: any, { agentId }: { agentId: string }, context: ApolloContext, _info: any): string[] | null => {
            // This query remains for fetching historical logs if needed, but real-time is via subscription
            const logs = context.agentManager.getAgentLogs(agentId);
            if (logs === null) {
              // Optionally throw a GraphQL error if agent not found or not local
              // throw new GraphQLError(`Agent with ID ${agentId} not found or is not a local agent.`, { extensions: { code: 'AGENT_NOT_FOUND' } });
              return null; // Or return null/empty array as per schema
            }
            return logs;
          },
  },
  Mutation: {
    spawnKaAgent: async (_parent: any, args: {
      model?: string,
      systemPrompt?: string,
      apiBaseUrl?: string,
      port?: number | null,
      name?: string,
      description?: string,
      providerType?: 'LMSTUDIO' | 'GOOGLE',
      environmentVariables?: JSONObject,
      executionMode: 'BARE_HOST' | 'DOCKERIZED', // Add new argument
      scopePath?: string // Add new argument
    }, context: { agentManager: AgentManager }, _info: any): Promise<Agent> => { // Change return type to non-nullable Agent
      console.log('[GraphQL spawnKaAgent] Received args:', args);
      // Pass the new arguments to spawnLocalAgent
      const spawnedAgent = await context.agentManager.spawnLocalAgent({
        model: args.model,
        systemPrompt: args.systemPrompt,
        apiBaseUrl: args.apiBaseUrl,
        port: args.port,
        name: args.name,
        description: args.description,
        providerType: args.providerType,
        environmentVariables: args.environmentVariables,
        executionMode: args.executionMode, // Pass new argument
        scopePath: args.scopePath, // Pass new argument
      });

      if (!spawnedAgent) {
        // If spawnLocalAgent returns null, throw a GraphQL error
        throw new GraphQLError('Failed to spawn local agent.', {
          extensions: { code: 'AGENT_SPAWN_FAILED' },
        });
      }

      // Send MCP configurations to the spawned agent (moved outside the spawn try/catch)
      try {
        const mcpServers = await readMcpServers();
        console.log(`[GraphQL spawnKaAgent] Read ${mcpServers.length} MCP server configurations.`);

        if (mcpServers.length > 0) {
          const setConfigUrl = `${spawnedAgent.url.replace(/\/+$/, '')}/set-mcp-config`;
          console.log(`[GraphQL spawnKaAgent] Sending MCP configurations to agent at ${setConfigUrl}`);
          const setConfigResponse = await axios.post(setConfigUrl, mcpServers); // Send as JSON array
          console.log(`[GraphQL spawnKaAgent] Successfully sent MCP configurations to agent ${spawnedAgent.id}. Status: ${setConfigResponse.status}`);
          console.log(`[GraphQL spawnKaAgent] Response data from /set-mcp-config:`, setConfigResponse.data);

        } else {
          console.log(`[GraphQL spawnKaAgent] No MCP server configurations to send to agent ${spawnedAgent.id}.`);
        }
      } catch (error: any) {
        console.error(`[GraphQL spawnKaAgent] Error sending MCP configurations to agent ${spawnedAgent.id}:`, error);
        // Log the original error details for debugging
        if (error.response) {
          console.error(`[GraphQL spawnKaAgent] Agent response status: ${error.response.status}`);
          console.error(`[GraphQL spawnKaAgent] Agent response data:`, error.response.data);
          console.error(`[GraphQL spawnKaAgent] Agent response headers:`, error.response.headers);
        } else if (error.request) {
          console.error(`[GraphQL spawnKaAgent] No response received from agent. Request details:`, error.request);
        } else {
          console.error(`[GraphQL spawnKaAgent] Error setting up the request to agent:`, error.message);
        }
        // Decide how to handle this error: fail the spawn mutation or just log a warning?
        // For now, we'll log a warning and return the agent, as the agent might still function without MCP tools.
        // A more robust solution might require the agent to confirm config received.
      }

      return spawnedAgent; // Return the spawned agent if successful
    },

    addAgent: (_parent: any, { url, name }: { url: string, name?: string }, context: ApolloContext, _info: any): Agent => {
      return context.agentManager.addRemoteAgent(url, name);
    },
    removeAgent: (_parent: any, { id }: { id: string }, context: ApolloContext, _info: any): boolean => {
      return context.agentManager.removeAgent(id);
    },

    stopKaAgent: (_parent: any, { id }: { id: string }, context: ApolloContext, _info: any): boolean => {
      // Use removeAgent which handles stopping local agents internally
      return context.agentManager.removeAgent(id);
    },

    updateAgent: (_parent: any, { agentId, updates }: { agentId: string, updates: UpdateAgentInput }, context: ApolloContext, _info: any): Agent | undefined => {
      console.log(`[GraphQL updateAgent] Received update request for agent ${agentId} with updates:`, updates);
      const updatedAgent = context.agentManager.updateAgent(agentId, updates);
      if (!updatedAgent) {
        console.warn(`[GraphQL updateAgent] Agent with ID ${agentId} not found for update.`);
      } else {
        console.log(`[GraphQL updateAgent] Agent ${agentId} updated successfully.`);
      }
      return updatedAgent;
    },
  },


};
