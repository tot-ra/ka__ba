import { EventEmitter } from 'node:events';

export interface Agent {
  id: string;
  url: string;
  name?: string;
  description?: string;
  isLocal: boolean;
  capabilities?: AgentCapabilities | null;
  subscriptionController?: AbortController; // Use AbortController directly
  systemPrompt?: string; // Add systemPrompt field
  providerType?: 'LMSTUDIO' | 'GOOGLE'; // Add LLM provider type
  environmentVariables?: { [key: string]: any }; // Add environment variables
  executionMode?: 'BARE_HOST' | 'DOCKERIZED'; // Add executionMode field
}

interface AgentCapabilities {
  name: string;
  description: string;
  url: string;
  api_version: string;
  protocol_version: string;
  endpoints: {
    tasks_send: string;
    tasks_send_subscribe?: string;
    tasks_status: string;
    tasks_artifact?: string;
  };
  authentication: string[];
}

export class AgentRegistry {
  private agents: Agent[] = [];
  private agentIdCounter = 1;
  private eventEmitter: EventEmitter;

  constructor(eventEmitter: EventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  public getNextAgentId(): string {
      return (this.agentIdCounter++).toString();
  }

  private notifyAgents() {
    const agentUrls = this.agents.map(agent => agent.url);
    console.log('Notifying agents about updated list:', agentUrls);
    // This notification logic might need to stay in AgentManager or a higher level orchestrator
    // For now, just log that it would happen. The actual POST request logic will be handled elsewhere.
    // In the refactored AgentManager, it will call a method on this registry
    // which in turn might trigger a notification via the orchestrator.
  }

  public findAgent(agentId: string): Agent | undefined {
    return this.agents.find(agent => agent.id === agentId);
  }

  public getAgents(): Agent[] {
    return this.agents;
  }

  public addRemoteAgent(url: string, name?: string): Agent {
    const newAgent: Agent = {
      id: (this.agentIdCounter++).toString(),
      url,
      name: name || `Agent ${this.agentIdCounter - 1}`,
      description: `Agent at ${url}`,
      isLocal: false,
    };
    this.agents.push(newAgent);
    console.log(`Added remote agent: ${newAgent.url}`);
    this.notifyAgents(); // Notify after adding
    return newAgent;
  }

  public removeAgent(id: string): Agent | undefined {
    const index = this.agents.findIndex(agent => agent.id === id);
    if (index > -1) {
      const removedAgent = this.agents.splice(index, 1)[0];
      console.log(`Removed agent: ${removedAgent.url}`);
      this.notifyAgents(); // Notify after removing
      return removedAgent;
    }
    return undefined;
  }

  // Method to add a pre-created agent (useful for local agents spawned elsewhere)
  public addAgent(agent: Agent): void {
      // If ID is provided, ensure counter is ahead of it
      if (agent.id) {
          const idNum = parseInt(agent.id, 10);
          if (!isNaN(idNum) && idNum >= this.agentIdCounter) {
              this.agentIdCounter = idNum + 1;
          }
      }
      this.agents.push(agent);
      console.log(`Added agent: ${agent.url} (ID: ${agent.id})`);
      this.notifyAgents();
  }
}
