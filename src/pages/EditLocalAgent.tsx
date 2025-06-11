import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import styles from './EditLocalAgent.module.css'; // Use the new CSS module
import AgentList from '../components/AgentList'; // Import AgentList
import { useAgent } from '../contexts/AgentContext'; // Import useAgent hook
import Button from '../components/Button';
import AgentLogs from '../components/AgentLogs'; // Import AgentLogs
import { sendGraphQLRequest } from '../utils/graphqlClient'; // Import the sendGraphQLRequest utility

interface ToolDefinition {
  name: string;
  description: string;
}

interface AgentDetails {
  id: string;
  url: string;
  name: string;
  description: string;
  isLocal: boolean;
  systemPrompt?: string; // Add systemPrompt field
  pid?: number; // Add pid for AgentList
  providerType?: 'LMSTUDIO' | 'GOOGLE'; // Add LLM provider type
  environmentVariables?: Record<string, string>; // Update type to Record<string, string>
  executionMode?: 'BARE_HOST' | 'DOCKERIZED'; // Add executionMode
  apiBaseUrl?: string; // Add apiBaseUrl to AgentDetails
}

interface EditedAgentDetails extends Partial<AgentDetails> {
  apiBaseUrl?: string; // Explicitly include apiBaseUrl in edited state
}

interface McpServerConfig {
  name: string;
  timeout: number;
  command: string;
  args: string[];
  transportType: string;
  env: { [key: string]: string };
}

const EditLocalAgent: React.FC = () => {
  const navigate = useNavigate();
  const { agentId } = useParams<{ agentId: string }>(); // Get agentId from URL

  // Use context for agents and selectedAgentId
  const { fetchAgents: fetchAgentsFromContext, setSelectedAgentId } = useAgent();

  const [agentDetails, setAgentDetails] = useState<AgentDetails | null>(null);
  const [isLoadingAgent, setIsLoadingAgent] = useState(true);
  const [errorLoadingAgent, setErrorLoadingAgent] = useState<string | null>(null);

  const [editedAgentDetails, setEditedAgentDetails] = useState<EditedAgentDetails>({}); // State for edited fields

  const [allAgents, setAllAgents] = useState<AgentDetails[]>([]); // State for all agents
  const [isLoadingAgents, setIsLoadingAgents] = useState(true); // Loading state for all agents
  const [errorLoadingAgents, setErrorLoadingAgents] = useState<string | null>(null);

  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]); // State for MCP servers
  const [isLoadingMcpServers, setIsLoadingMcpServers] = useState(true); // Loading state for MCP servers
  const [errorLoadingMcpServers, setErrorLoadingMcpServers] = useState<string | null>(null);

  const [availableTools, setAvailableTools] = useState<ToolDefinition[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]); // Stores names of selected regular tools
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]); // Stores names of selected MCP servers
  const [composedSystemPrompt, setComposedSystemPrompt] = useState<string>('');
  const [isFetchingTools, setIsFetchingTools] = useState(false);
  const [isComposingPrompt, setIsComposingPrompt] = useState(false);
  const [isUpdatingPrompt, setIsUpdatingPrompt] = useState(false);
  const [currentViewTab, setCurrentViewTab] = useState<'details' | 'logs'>('details'); // State for active tab

  // Fetch agent details on component mount
  useEffect(() => {
    const fetchAgentDetails = async () => {
      if (!agentId) {
        setErrorLoadingAgent('Agent ID is missing.');
        setIsLoadingAgent(false);
        return;
      }
      setIsLoadingAgent(true);
      setErrorLoadingAgent(null);
      try {
        const response = await sendGraphQLRequest(`
            query GetAgent($agentId: ID!) {
              agent(id: $agentId) {
                id
                url
                name
                description
            isLocal
            systemPrompt # Fetch systemPrompt
            pid # Fetch pid
            providerType # Fetch providerType
            environmentVariables # Fetch environmentVariables
            executionMode # Fetch executionMode
          }
        }
      `, { agentId });

    if (response.errors) {
      console.error('GraphQL errors fetching agent details:', response.errors);
      setErrorLoadingAgent('Failed to fetch agent details: ' + response.errors.map(err => err.message).join(', '));
      setIsLoadingAgent(false);
    } else if (response.data?.agent) {
      const agent = response.data.agent as AgentDetails; // Add type assertion
      setAgentDetails(agent);
      setEditedAgentDetails({ // Initialize edited state with fetched details
        name: agent.name,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        providerType: agent.providerType,
        environmentVariables: agent.environmentVariables,
        executionMode: agent.executionMode, // Initialize executionMode
        apiBaseUrl: agent.url, // Initialize apiBaseUrl from agent URL (approximation)
      });
      setComposedSystemPrompt(agent.systemPrompt || ''); // Initialize prompt with existing one
      // Note: We don't have info on *which* tools were used to compose the *current* prompt,
      // so we'll just fetch available tools and let the user re-select/re-compose if needed.
      fetchAvailableTools(agent.id);
    } else {
      setErrorLoadingAgent('Agent not found or failed to fetch details.');
      setIsLoadingAgent(false);
    }
  } catch (error: any) {
    console.error('Error fetching agent details:', error);
    setErrorLoadingAgent(`Error loading agent: ${error.message}`);
    setIsLoadingAgent(false);
  }
};

    fetchAgentDetails();
  }, [agentId]); // Re-run effect if agentId changes

  // Fetch all agents for the list
  useEffect(() => {
    const fetchAllAgents = async () => {
      setIsLoadingAgents(true);
      setErrorLoadingAgents(null);
      try {
        const GET_AGENTS_QUERY = `
            query GetAgents {
              agents {
                id
                url
                name
                description
                isLocal
                pid # Fetch pid for AgentList
              }
            }
          `;
        const response = await sendGraphQLRequest(GET_AGENTS_QUERY);

        if (response.errors) {
          console.error('GraphQL errors fetching agents:', response.errors);
          setErrorLoadingAgents('Failed to load agent list: ' + response.errors.map(err => err.message).join(', '));
        } else if (Array.isArray(response.data?.agents)) {
          setAllAgents(response.data.agents as AgentDetails[]); // Add type assertion
        } else {
          console.error('Failed to fetch agents or received invalid data:', response);
          setErrorLoadingAgents('Failed to load agent list.');
        }
      } catch (error: any) {
        console.error('Error fetching agents:', error);
        setErrorLoadingAgents(`Error loading agent list: ${error.message}`);
      } finally {
        setIsLoadingAgents(false);
      }
    };

    fetchAllAgents();
  }, []); // Fetch agents only once on mount

  // Fetch MCP servers on component mount
  useEffect(() => {
    const fetchMcpServers = async () => {
      setIsLoadingMcpServers(true);
      setErrorLoadingMcpServers(null);
      const GET_MCP_SERVERS_QUERY = `
        query GetMcpServers {
          mcpServers {
            name
            timeout
            command
            args
            transportType
            env
          }
        }
      `;
      try {
        const response = await sendGraphQLRequest(GET_MCP_SERVERS_QUERY);

        if (response.errors) {
          console.error('GraphQL errors fetching MCP servers:', response.errors);
          setErrorLoadingMcpServers('Failed to fetch MCP servers: ' + response.errors.map(err => err.message).join(', '));
        } else if (response.data?.mcpServers) {
          console.log('MCP servers fetched successfully:', response.data.mcpServers);
          setMcpServers(response.data.mcpServers);
        } else {
          console.error('Unexpected GraphQL response fetching MCP servers:', response);
          setErrorLoadingMcpServers('Failed to fetch MCP servers: Unexpected response from server.');
        }
      } catch (error: any) {
        setErrorLoadingMcpServers('Failed to fetch MCP servers: ' + error.message);
        console.error('Error fetching MCP servers:', error);
      } finally {
        setIsLoadingMcpServers(false);
      }
    };

    fetchMcpServers();
  }, []); // Fetch MCP servers only once on mount


  const fetchAvailableTools = async (agentId: string) => {
    setIsFetchingTools(true);
    try {
      const AVAILABLE_TOOLS_QUERY = `
          query AvailableTools($agentId: ID!) {
            availableTools(agentId: $agentId) {
              name
              description
            }
            }
          `;
      const response = await sendGraphQLRequest(AVAILABLE_TOOLS_QUERY, { agentId });

      if (response.errors) {
        console.error('GraphQL errors fetching available tools:', response.errors);
        // Optionally set an error message for tools
      } else if (Array.isArray(response.data?.availableTools)) {
        setAvailableTools(response.data.availableTools as ToolDefinition[]); // Add type assertion
      } else {
        console.error('Failed to fetch available tools or received invalid data:', response);
        // Optionally set an error message for tools
      }
    } catch (error: any) {
      console.error('Error fetching available tools:', error);
      // Optionally set an error message for tools
    } finally {
      setIsFetchingTools(false);
      setIsLoadingAgent(false); // Loading is complete after fetching tools
    }
  };

  // Add a new useEffect to automatically select all tools and compose prompt when tools and MCP servers are loaded
  useEffect(() => {
    if (availableTools.length > 0 && mcpServers.length > 0 && agentDetails?.id) {
      // Select all tools automatically
      setSelectedTools(availableTools.map(tool => tool.name));
      // Select all MCP servers automatically
      setSelectedMcpServers(mcpServers.map(server => server.name));
      
      // Trigger prompt composition automatically
      const composePromptWithAll = async () => {
        setIsComposingPrompt(true);
        try {
          console.log('Sending ComposeSystemPrompt request from useEffect...'); // Added log
          const COMPOSE_PROMPT_MUTATION = `
              mutation ComposeSystemPrompt($agentId: ID!, $toolNames: [String!]!, $mcpServerNames: [String!]!) {
                composeSystemPrompt(agentId: $agentId, toolNames: $toolNames, mcpServerNames: $mcpServerNames)
              }
            `;
          const response = await sendGraphQLRequest(COMPOSE_PROMPT_MUTATION, {
            agentId: agentDetails.id,
            toolNames: availableTools.map(tool => tool.name),
            mcpServerNames: mcpServers.map(server => server.name),
          });

          console.log('Composed system prompt full response from useEffect:', response); // Modified log
          if (response.errors) {
            console.error('GraphQL errors auto-composing system prompt from useEffect:', response.errors); // Modified log
            console.error('GraphQL response errors details from useEffect:', response.errors); // Added specific error logging
          } else if (response.data) { // Check for data presence
             console.log('GraphQL response data from useEffect:', response.data); // Added specific data logging
            if (typeof response.data.composeSystemPrompt === 'string') {
              setComposedSystemPrompt(response.data.composeSystemPrompt as string); // Add type assertion
            } else {
               console.error('composeSystemPrompt field is not a string or is missing in response data from useEffect:', response.data); // Added check for expected data type
            }
          } else {
             console.error('GraphQL response has no data or errors from useEffect:', response); // Added check for empty response
          }
        } catch (error: any) { // Added type assertion for error
          console.error('Error sending or processing ComposeSystemPrompt request from useEffect:', error); // Modified log and added catch
        } finally {
          setIsComposingPrompt(false);
        }
      };

      composePromptWithAll();
    }
  }, [availableTools, mcpServers, agentDetails?.id]); // Depend on both tools and MCP servers

  const handleToolSelection = useCallback((toolName: string) => {
    setSelectedTools(prevSelected => {
      const newSelection = prevSelected.includes(toolName)
        ? prevSelected.filter(name => name !== toolName)
        : [...prevSelected, toolName];
      
      // Automatically recompose prompt when selection changes
      if (agentDetails?.id) {
        setIsComposingPrompt(true);
        const COMPOSE_PROMPT_MUTATION = `
            mutation ComposeSystemPrompt($agentId: ID!, $toolNames: [String!]!, $mcpServerNames: [String!]!) {
              composeSystemPrompt(agentId: $agentId, toolNames: $toolNames, mcpServerNames: $mcpServerNames)
            }
          `;
        sendGraphQLRequest(COMPOSE_PROMPT_MUTATION, {
          agentId: agentDetails.id,
          toolNames: newSelection,
          mcpServerNames: selectedMcpServers, // Include current MCP server selection
        })
          .then(response => {
            if (response.errors) {
              console.error('GraphQL errors recomposing system prompt:', response.errors);
            } else if (typeof response.data?.composeSystemPrompt === 'string') {
              setComposedSystemPrompt(response.data.composeSystemPrompt as string); // Add type assertion
            }
          })
          .catch(error => {
            console.error('Error recomposing system prompt:', error);
          })
          .finally(() => {
            setIsComposingPrompt(false);
          });
      }

      return newSelection;
    });
  }, [agentDetails?.id, selectedMcpServers]); // Depend on agentDetails and selectedMcpServers

  const handleMcpServerSelection = useCallback((serverName: string) => {
    setSelectedMcpServers(prevSelected => {
      const newSelection = prevSelected.includes(serverName)
        ? prevSelected.filter(name => name !== serverName)
        : [...prevSelected, serverName];

      // Automatically recompose prompt when selection changes
      if (agentDetails?.id) {
        setIsComposingPrompt(true);
        console.log('Sending ComposeSystemPrompt request from handleMcpServerSelection...'); // Added log
        sendGraphQLRequest(`
            mutation ComposeSystemPrompt($agentId: ID!, $toolNames: [String!]!, $mcpServerNames: [String!]!) {
              composeSystemPrompt(agentId: $agentId, toolNames: $toolNames, mcpServerNames: $mcpServerNames)
            }
          `, {
          agentId: agentDetails.id,
          toolNames: selectedTools, // Include current tool selection
          mcpServerNames: newSelection,
        })
          .then(response => {
            console.log('ComposeSystemPrompt full response in handleMcpServerSelection:', response); // Modified log
            if (response.errors) {
              console.error('GraphQL errors recomposing system prompt in handleMcpServerSelection:', response.errors); // Modified log
              console.error('GraphQL response errors details:', response.errors); // Added specific error logging
            } else if (response.data) { // Check for data presence
              console.log('GraphQL response data in handleMcpServerSelection:', response.data); // Added specific data logging
              if (typeof response.data.composeSystemPrompt === 'string') {
                setComposedSystemPrompt(response.data.composeSystemPrompt as string); // Add type assertion
              } else {
                 console.error('composeSystemPrompt field is not a string or is missing in response data:', response.data); // Added check for expected data type
              }
            } else {
               console.error('GraphQL response has no data or errors in handleMcpServerSelection:', response); // Added check for empty response
            }
          })
          .catch(error => {
            console.error('Error sending or processing ComposeSystemPrompt request from handleMcpServerSelection:', error); // Modified log and added catch
          })
          .finally(() => {
            setIsComposingPrompt(false);
          });
      }

      return newSelection;
    });
  }, [agentDetails?.id, selectedTools]); // Depend on agentDetails and selectedTools


  const handleUpdateAgent = async () => {
    if (!agentDetails || Object.keys(editedAgentDetails).length === 0) {
      // No changes to save or agent details not loaded
      return;
    }

    setIsUpdatingPrompt(true); // Reuse this state for any update
    try {
      // Prepare updates object
      let updatesToSend: Partial<AgentDetails> = { ...editedAgentDetails };

      // Ensure environmentVariables is a parsed JSON object (Record<string, string>)
      let parsedEnvironmentVariables: Record<string, string> = {};
      // Check if environmentVariables exists and is a string before attempting to parse
      if (updatesToSend.environmentVariables && typeof updatesToSend.environmentVariables === 'string') {
         try {
            const parsed = JSON.parse(updatesToSend.environmentVariables);
             if (typeof parsed === 'object' && parsed !== null) {
                for (const key in parsed) {
                  if (Object.prototype.hasOwnProperty.call(parsed, key) && typeof parsed[key] === 'string') {
                    parsedEnvironmentVariables[key] = parsed[key];
                  }
                }
              }
         } catch (e) {
            console.error('Invalid JSON for environment variables:', e);
            // Handle invalid JSON error, maybe set a status message
            setIsUpdatingPrompt(false);
            return;
         }
      } else if (updatesToSend.environmentVariables && typeof updatesToSend.environmentVariables === 'object') {
         // If it's already an object, use it directly
         parsedEnvironmentVariables = updatesToSend.environmentVariables;
      }

      if (agentDetails?.executionMode === 'DOCKERIZED' && !parsedEnvironmentVariables.apiBaseUrl) {
         parsedEnvironmentVariables.apiBaseUrl = 'http://host.docker.internal:1234/v1';
      }

      updatesToSend.environmentVariables = parsedEnvironmentVariables; // Assign the potentially updated object

      const UPDATE_AGENT_MUTATION = `
          mutation UpdateAgent($agentId: ID!, $updates: UpdateAgentInput!) {
            updateAgent(agentId: $agentId, updates: $updates) {
              id
              name
              description
              systemPrompt
              providerType
              environmentVariables
            }
          }
        `;
      const response = await sendGraphQLRequest(UPDATE_AGENT_MUTATION, { agentId: agentDetails.id, updates: updatesToSend });

      if (response.errors) {
        console.error('GraphQL errors updating agent:', response.errors);
        // Optionally set an error message
      } else if (response.data?.updateAgent?.id) {
        // Success - update local state with the new details from the response
        console.log('Agent updated successfully:', response.data.updateAgent);
        setAgentDetails(response.data.updateAgent);
        setEditedAgentDetails(response.data.updateAgent); // Update edited state as well
        setComposedSystemPrompt(response.data.updateAgent.systemPrompt || ''); // Update composed prompt

        // Add navigation to agent view page
        navigate(`/agents/view/${agentDetails.id}`);

      } else {
        console.error('Failed to update agent or received invalid data:', response);
        // Optionally set an error message
      }
    } catch (error: any) {
      console.error('Error updating agent:', error);
      // Optionally set an error message
    } finally {
      setIsUpdatingPrompt(false);
    }
  };

  // Placeholder handlers for AgentList - actual logic needs to be implemented or state lifted
  const handleSelectAgent = useCallback((id: string) => {
    // Navigate to the edit page for the selected agent
    navigate(`/agents/edit/${id}`);
  }, [navigate]);

  const handleStopAgent = useCallback(async (agentId: string) => {
    console.log('Attempting to stop agent:', agentId);
    try {
      const response = await sendGraphQLRequest(`
          mutation StopKaAgent($id: ID!) {
            stopKaAgent(id: $id)
          }
        `, {
        id: agentId,
      });
      if (response.errors) {
        console.error('GraphQL errors stopping agent:', response.errors);
      } else if (response.data?.stopKaAgent) {
        console.log('Agent stopped successfully:', agentId);
        // Refresh the agent list via context after stopping
        fetchAgentsFromContext();
        // If the stopped agent was selected, deselect it via context and navigate back to the list
        if (agentDetails?.id === agentId) { // Use agentDetails?.id to check if the current agent is the one stopped
          setSelectedAgentId(null);
          navigate('/agents'); // Navigate back to the agent list
        }
      } else {
        console.error('Failed to stop agent:', agentId);
      }
    } catch (error) {
      console.error('Error stopping agent:', error);
    }
  }, [fetchAgentsFromContext, setSelectedAgentId, agentDetails?.id]); // Add dependencies


  if (isLoadingAgent || isLoadingAgents || isLoadingMcpServers) {
    return <div className={styles.splitViewContainer}><div className={styles.leftPane}><p>Loading agent details, list, and MCP servers...</p></div></div>;
  }

  if (errorLoadingAgent) {
    return <div className={styles.splitViewContainer}><div className={styles.leftPane}><p className={styles.alertError}>{errorLoadingAgent}</p></div></div>;
  }

  if (errorLoadingMcpServers) {
    return <div className={styles.splitViewContainer}><div className={styles.leftPane}><p className={styles.alertError}>{errorLoadingMcpServers}</p></div></div>;
  }

  if (!agentDetails) {
     return <div className={styles.splitViewContainer}><div className={styles.leftPane}><p className={styles.alertInfo}>Agent details could not be loaded.</p></div></div>;
  }


  // Tab styles (can be moved to CSS module if preferred)
  const tabStyle: React.CSSProperties = {
    padding: '10px 15px',
    cursor: 'pointer',
    border: '1px solid #ccc',
    borderBottom: 'none',
    marginRight: '5px',
    borderRadius: '4px 4px 0 0',
    backgroundColor: '#f0f0f0', // Slightly different from AgentInteraction for distinction
    opacity: 0.7,
  };
  const activeTabStyle: React.CSSProperties = {
    ...tabStyle,
    backgroundColor: '#fff',
    borderBottom: '1px solid #fff',
    fontWeight: 'bold',
    opacity: 1,
  };

  return (
    <div className={styles.splitViewContainer}>
      {isLoadingAgents ? (
        <p>Loading agent list...</p>
      ) : errorLoadingAgents ? (
        <p className={styles.alertError}>{errorLoadingAgents}</p>
      ) : (
        <AgentList
          agents={allAgents}
          selectedAgentId={agentId || null} // Highlight the currently edited agent
          handleSelectAgent={handleSelectAgent}
          handleStopAgent={handleStopAgent} // Use placeholder for now
        />
      )}
      <div className={styles.editFormPane}> {/* Edit form on the right */}
        <div style={{ marginBottom: '1rem', borderBottom: '1px solid #ccc', paddingBottom: '0px' }}>
          <button
            style={currentViewTab === 'details' ? activeTabStyle : tabStyle}
            onClick={() => setCurrentViewTab('details')}
          >
            Details
          </button>
          <button
            style={currentViewTab === 'logs' ? activeTabStyle : tabStyle}
            onClick={() => setCurrentViewTab('logs')}
          >
            Logs
          </button>
        </div>

        {currentViewTab === 'details' && (
          <div className={styles.paper}>
            <h2>Edit Local Agent: {agentDetails.name}</h2>
            <p>Agent PID: {agentDetails.pid}</p>
            <p>Agent URL: <a target="_blank" rel="noopener noreferrer" href={agentDetails.url}>{agentDetails.url}</a></p>

            {/* Agent Name */}
            <div className={styles.formField}>
              <label htmlFor="editName" className={styles.formLabel}>Agent Name</label>
              <input
                type="text"
                id="editName"
                name="name"
                value={editedAgentDetails.name || ''}
                onChange={(e) => setEditedAgentDetails({ ...editedAgentDetails, name: e.target.value })}
                className={styles.formInput}
              />
            </div>

            {/* Agent Description */}
            <div className={styles.formField}>
              <label htmlFor="editDescription" className={styles.formLabel}>Agent Description</label>
              <textarea
                 id="editDescription"
                 name="description"
                 value={editedAgentDetails.description || ''}
                 onChange={(e) => setEditedAgentDetails({ ...editedAgentDetails, description: e.target.value })}
                 rows={3}
                 className={styles.formTextarea}
              />
            </div>

            {/* LLM Provider Type */}
            <div className={styles.formField}>
              <label htmlFor="editProviderType" className={styles.formLabel}>LLM Provider</label>
              <select
                id="editProviderType"
                name="providerType"
                value={editedAgentDetails.providerType || ''}
                onChange={(e) => setEditedAgentDetails({ ...editedAgentDetails, providerType: e.target.value as 'LMSTUDIO' | 'GOOGLE' })}
                className={styles.formInput}
              >
                <option value="LMSTUDIO">LM Studio</option>
                <option value="GOOGLE">Google</option>
                {/* Add other providers here as they are supported */}
              </select>
            </div>

             {/* API Base URL (Conditionally rendered) */}
            {agentDetails.executionMode === 'BARE_HOST' && (
              <div className={styles.formField}>
                <label htmlFor="editApiBaseUrl" className={styles.formLabel}>API Base URL</label>
                <input
                  type="text"
                  id="editApiBaseUrl"
                  name="apiBaseUrl"
                  value={editedAgentDetails.apiBaseUrl || ''}
                  onChange={(e) => setEditedAgentDetails({ ...editedAgentDetails, apiBaseUrl: e.target.value })}
                  className={styles.formInput}
                />
              </div>
            )}

             {/* Environment Variables */}
            <div className={styles.formField}>
              <label htmlFor="editEnvironmentVariables" className={styles.formLabel}>Environment Variables (JSON)</label>
              <textarea
                id="editEnvironmentVariables"
                name="environmentVariables"
                placeholder='e.g., {"GEMINI_API_KEY": "YOUR_API_KEY"}'
                value={typeof editedAgentDetails.environmentVariables === 'object' ? JSON.stringify(editedAgentDetails.environmentVariables, null, 2) : editedAgentDetails.environmentVariables || ''}
                onChange={(e) => {
                  // Store as string for now, handle parsing on update
                  setEditedAgentDetails({ ...editedAgentDetails, environmentVariables: e.target.value as any });
                }}
                rows={5}
                className={styles.formTextarea}
              />
            </div>


            <div className={styles.toolSelectionSection}>
              <h3>Available Tools</h3>
              {isFetchingTools ? (
                <p>Loading tools...</p>
              ) : availableTools.length > 0 ? (
                <div>
                  {availableTools.map(tool => (
                    <div key={tool.name} className={styles.toolCheckbox}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedTools.includes(tool.name)}
                          onChange={() => handleToolSelection(tool.name)}
                        />
                        <strong>{tool.name}:</strong> {tool.description}
                      </label>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No tools available for this agent.</p>
              )}

              <h3>Available MCP Servers</h3>
              {isLoadingMcpServers ? (
                <p>Loading MCP servers...</p>
              ) : mcpServers.length > 0 ? (
                <div>
                  {mcpServers.map(server => (
                    <div key={server.name} className={styles.toolCheckbox}> {/* Reuse toolCheckbox style */}
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedMcpServers.includes(server.name)}
                          onChange={() => handleMcpServerSelection(server.name)}
                        />
                        <strong>{server.name}:</strong> {server.transportType} ({server.command} {server.args.join(' ')})
                      </label>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No MCP servers configured.</p>
              )}


              {composedSystemPrompt && (
                <div className={styles.composedPromptSection}>
                  <h4>System Prompt:</h4>
                  <textarea
                    value={composedSystemPrompt}
                    onChange={(e) => setComposedSystemPrompt(e.target.value)}
                    rows={30}
                    className={styles.formTextarea}
                  />

                  <Button
                      onClick={() => navigate('/agents')}
                      variant="secondary"
                      style={{ marginBottom: '16px', marginRight: '8px' }}
                  >
                    &larr; Back to Agent List
                  </Button>

                  <Button
                    onClick={handleUpdateAgent} // Use the new update handler
                    disabled={isUpdatingPrompt || isComposingPrompt} // Disable while composing or updating
                    variant="primary"
                  >
                    {isUpdatingPrompt || isComposingPrompt ? <div className={styles.spinner}></div> : null}
                    {isUpdatingPrompt ? 'Updating Agent...' : isComposingPrompt ? 'Composing Prompt...' : 'Update Agent'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
        {currentViewTab === 'logs' && agentId && (
          <div className={styles.logsPaper} style={{paddingTop: "10px"}}> {/* Added paddingTop to prevent overlap with tab border */}
            <AgentLogs agentId={agentId} />
          </div>
        )}
      </div>
    </div>
  );
};

export default EditLocalAgent;
