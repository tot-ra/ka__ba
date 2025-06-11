import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import styles from './AddLocalAgent.module.css';

type MessageType = 'success' | 'error' | 'info' | null;

interface ToolDefinition {
  name: string;
  description: string;
}

const AddLocalAgent: React.FC = () => {
  const navigate = useNavigate();

  const [spawnAgentConfig, setSpawnAgentConfig] = useState({
    model: 'qwen3-30b-a3b', //'qwen3-30b-a3b',
    apiBaseUrl: 'http://host.docker.internal:1234',
    port: '',
    name: 'Software Engineer',
    description: 'An AI assistant specialized in software engineering tasks.',
    providerType: 'LMSTUDIO', // or LMSTUDIO
    environmentVariables: '{}', // Default empty JSON object string
    executionMode: 'DOCKERIZED' as 'BARE_HOST' | 'DOCKERIZED', // Add execution mode
    scopePath: '~', // Add scope path
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSpawning, setIsSpawning] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<MessageType>(null);

  const [spawnedAgentId, setSpawnedAgentId] = useState<string | null>(null);
  const [availableTools, setAvailableTools] = useState<ToolDefinition[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [composedSystemPrompt, setComposedSystemPrompt] = useState<string>('');
  const [isFetchingTools, setIsFetchingTools] = useState(false);
  const [isComposingPrompt, setIsComposingPrompt] = useState(false);
  const [isUpdatingPrompt, setIsUpdatingPrompt] = useState(false);


  const handleSpawnAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSpawning(true);
    setStatusMessage(null);
    setMessageType(null);
    setSpawnedAgentId(null); // Reset agent ID on new spawn attempt
    setAvailableTools([]); // Reset tools
    setSelectedTools([]); // Reset selected tools
    setComposedSystemPrompt(''); // Reset composed prompt

    console.log('Attempting to spawn agent with config:', spawnAgentConfig);

    let parsedEnvironmentVariables: Record<string, string> = {}; // Use Record<string, string> for environment variables
    try {
      // Ensure the parsed result is treated as Record<string, string>
      const parsed = JSON.parse(spawnAgentConfig.environmentVariables);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const key in parsed) {
          if (Object.prototype.hasOwnProperty.call(parsed, key) && typeof parsed[key] === 'string') {
            parsedEnvironmentVariables[key] = parsed[key];
          }
        }
      }
    } catch (e) {
      setStatusMessage('Error: Invalid JSON for environment variables.');
      setMessageType('error');
      setIsSpawning(false);
      return; // Stop the spawn process if JSON is invalid
    }

    if (spawnAgentConfig.executionMode === 'DOCKERIZED') {
      // Assuming LM Studio is running on the host on port 56350 (based on user's comment)
      parsedEnvironmentVariables.apiBaseUrl = 'http://host.docker.internal:1234/v1';
    }


    const variables = {
      model: spawnAgentConfig.model,
      apiBaseUrl: spawnAgentConfig.apiBaseUrl,
      port: spawnAgentConfig.port ? parseInt(spawnAgentConfig.port.toString(), 10) : null,
      name: spawnAgentConfig.name || null,
      description: spawnAgentConfig.description || null,
      providerType: spawnAgentConfig.providerType,
      environmentVariables: parsedEnvironmentVariables,
      executionMode: spawnAgentConfig.executionMode, // Add executionMode
      scopePath: spawnAgentConfig.scopePath || null, // Add scopePath, use null if empty
      // systemPrompt is no longer sent during spawn
    };
    console.log('Variables being sent for spawn:', variables);

    try {
      const response = await axios.post('http://localhost:3000/graphql', {
        query: `
          mutation SpawnKaAgent($model: String, $apiBaseUrl: String, $port: Int, $name: String, $description: String, $providerType: LlmProviderType, $environmentVariables: JSONObject, $executionMode: String!, $scopePath: String) {
            spawnKaAgent(model: $model, apiBaseUrl: $apiBaseUrl, port: $port, name: $name, description: $description, providerType: $providerType, environmentVariables: $environmentVariables, executionMode: $executionMode, scopePath: $scopePath) {
              id
              url
              name
              description
              isLocal
            }
          }
        `,
        variables: variables,
      });
      const spawnedAgent = response.data.data.spawnKaAgent;
      if (spawnedAgent && spawnedAgent.id) {
        console.log('Agent spawned successfully:', spawnedAgent);
        setSpawnedAgentId(spawnedAgent.id);
        setStatusMessage(`Agent "${spawnedAgent.name}" spawned successfully! Redirecting to edit view...`);
        setMessageType('success');
        // Redirect immediately after successful spawn
        navigate(`/agents/edit/${spawnedAgent.id}`);
        // No longer proceeding to fetch tools or update prompt automatically after spawn
      } else {
        const errorMessage = response.data.errors?.[0]?.message || 'Failed to spawn agent or received invalid data.';
        console.error('Failed to spawn agent:', spawnAgentConfig, response.data);
        setStatusMessage(`Error: ${errorMessage}`);
        setMessageType('error');
        setIsSpawning(false);
      }
    } catch (error: any) {
      console.error('Error spawning agent:', error);
      const message = error.response?.data?.errors?.[0]?.message || error.message || 'An unknown error occurred.';
      setStatusMessage(`Error: ${message}`);
      setMessageType('error');
      setIsSpawning(false);
    }
  };

  const fetchAvailableTools = async (agentId: string) => {
    setIsFetchingTools(true);
    setStatusMessage(`Fetching available tools for agent ${agentId}...`);
    setMessageType('info');
    try {
      const response = await axios.post('http://localhost:3000/graphql', {
        query: `
          query AvailableTools($agentId: ID!) {
            availableTools(agentId: $agentId) {
              name
              description
            }
          }
        `,
        variables: { agentId },
      });
      const tools = response.data.data.availableTools;
      if (Array.isArray(tools)) {
        console.log('Available tools fetched:', tools);
        setAvailableTools(tools);
        setStatusMessage(`Successfully fetched ${tools.length} available tools.`);
        setMessageType('success');
      } else {
        console.error('Failed to fetch available tools or received invalid data:', response.data);
        setStatusMessage('Error: Failed to fetch available tools.');
        setMessageType('error');
      }
    } catch (error: any) {
      console.error('Error fetching available tools:', error);
      const message = error.response?.data?.errors?.[0]?.message || error.message || 'An unknown error occurred.';
      setStatusMessage(`Error fetching tools: ${message}`);
      setMessageType('error');
    } finally {
      setIsFetchingTools(false);
      setIsSpawning(false); // Spawning process is complete after fetching tools
    }
  };

  const handleToolSelection = (toolName: string) => {
    setSelectedTools(prevSelected =>
      prevSelected.includes(toolName)
        ? prevSelected.filter(name => name !== toolName)
        : [...prevSelected, toolName]
    );
  };

  const handleComposePrompt = async () => {
    if (!spawnedAgentId || selectedTools.length === 0) {
      setStatusMessage('Please spawn an agent and select at least one tool.');
      setMessageType('info');
      return;
    }

    setIsComposingPrompt(true);
    setStatusMessage(`Composing system prompt with ${selectedTools.length} selected tools...`);
    setMessageType('info');

    try {
      const response = await axios.post('http://localhost:3000/graphql', {
        query: `
          mutation ComposeSystemPrompt($agentId: ID!, $toolNames: [String!]!) {
            composeSystemPrompt(agentId: $agentId, toolNames: $toolNames)
          }
        `,
        variables: { agentId: spawnedAgentId, toolNames: selectedTools },
      });
      const composedPrompt = response.data.data.composeSystemPrompt;
      if (typeof composedPrompt === 'string') {
        console.log('System prompt composed:', composedPrompt);
        setComposedSystemPrompt(composedPrompt);
        setStatusMessage('System prompt composed successfully.');
        setMessageType('success');
      } else {
        console.error('Failed to compose system prompt or received invalid data:', response.data);
        setStatusMessage('Error: Failed to compose system prompt.');
        setMessageType('error');
      }
    } catch (error: any) {
      console.error('Error composing system prompt:', error);
      const message = error.response?.data?.errors?.[0]?.message || error.message || 'An unknown error occurred.';
      setStatusMessage(`Error composing prompt: ${message}`);
      setMessageType('error');
    } finally {
      setIsComposingPrompt(false);
    }
  };

  const handleUpdateAgentPrompt = async () => {
    if (!spawnedAgentId || !composedSystemPrompt) {
      setStatusMessage('Please compose a system prompt first.');
      setMessageType('info');
      return;
    }

    setIsUpdatingPrompt(true);
    setStatusMessage('Updating agent system prompt...');
    setMessageType('info');

    try {
      const response = await axios.post('http://localhost:3000/graphql', {
        query: `
          mutation UpdateAgentSystemPrompt($agentId: ID!, $systemPrompt: String!) {
            updateAgentSystemPrompt(agentId: $agentId, systemPrompt: $systemPrompt) {
              id
              name
            }
          }
        `,
        variables: { agentId: spawnedAgentId, systemPrompt: composedSystemPrompt },
      });
      const updatedAgent = response.data.data.updateAgentSystemPrompt;
      if (updatedAgent && updatedAgent.id) {
        console.log('Agent system prompt updated:', updatedAgent);
        setStatusMessage(`Agent "${updatedAgent.name}" system prompt updated successfully!`);
        setMessageType('success');
        // Optionally navigate or show a success message and allow further actions
        // Redirect is now handled after spawn
      } else {
        console.error('Failed to update agent system prompt or received invalid data:', response.data);
        setStatusMessage('Error: Failed to update agent system prompt.');
        setMessageType('error');
      }
    } catch (error: any) {
      console.error('Error updating agent system prompt:', error);
      const message = error.response?.data?.errors?.[0]?.message || error.message || 'An unknown error occurred.';
      setStatusMessage(`Error updating prompt: ${message}`);
      setMessageType('error');
    } finally {
      setIsUpdatingPrompt(false);
    }
  };


  return (
    <div className={styles.container}>
      <div className={styles.paper}>
        <form onSubmit={handleSpawnAgent} className={styles.form}>
          <div className={styles.formGrid}>
            {/* Agent Name */}
            <div className={styles.formField}>
              <label htmlFor="spawnName" className={styles.formLabel}>Agent Name (Optional)</label>
              <input
                type="text"
                id="spawnName"
                name="name"
                placeholder="Coder Assistant"
                value={spawnAgentConfig.name}
                onChange={(e) => setSpawnAgentConfig({ ...spawnAgentConfig, name: e.target.value })}
                className={styles.formInput}
              />
            </div>

            {/* Agent Description */}
            <div className={styles.formField}>
              <label htmlFor="spawnDescription" className={styles.formLabel}>Agent Description (Optional)</label>
              <textarea
                 id="spawnDescription"
                 name="description"
                 placeholder="Describe the agent's purpose or specialization"
                 value={spawnAgentConfig.description}
                 onChange={(e) => setSpawnAgentConfig({ ...spawnAgentConfig, description: e.target.value })}
                 rows={3}
                 className={styles.formTextarea}
              />
            </div>

            {/* Execution Mode */}
            <div className={styles.formField}>
              <label className={styles.formLabel}>Execution Mode</label>
              <div className={styles.radioGroup}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="executionMode"
                    value="BARE_HOST"
                    checked={spawnAgentConfig.executionMode === 'BARE_HOST'}
                    onChange={() => setSpawnAgentConfig({ ...spawnAgentConfig, executionMode: 'BARE_HOST', scopePath: '' })}
                    className={styles.radioInput}
                  />
                  Bare Host
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    name="executionMode"
                    value="DOCKERIZED"
                    checked={spawnAgentConfig.executionMode === 'DOCKERIZED'}
                    onChange={() => setSpawnAgentConfig({ ...spawnAgentConfig, executionMode: 'DOCKERIZED' })}
                    className={styles.radioInput}
                  />
                  Safe (Dockerized)
                </label>
              </div>
            </div>

            {/* Scope Path (Conditionally rendered) */}
            {spawnAgentConfig.executionMode === 'DOCKERIZED' && (
              <div className={styles.formField}>
                <label htmlFor="scopePath" className={styles.formLabel}>Scope Path (for Dockerized mode)</label>
                <input
                  type="text"
                  id="scopePath"
                  name="scopePath"
                  placeholder="/path/to/agent/sandbox"
                  value={spawnAgentConfig.scopePath}
                  onChange={(e) => setSpawnAgentConfig({ ...spawnAgentConfig, scopePath: e.target.value })}
                  className={styles.formInput}
                />
              </div>
            )}

            {/* LLM Provider */}
            <div className={styles.formField}>
              <label htmlFor="providerType" className={styles.formLabel}>LLM Provider</label>
              <select
                id="providerType"
                name="providerType"
                value={spawnAgentConfig.providerType}
                onChange={(e) => {
                  const providerType = e.target.value;
                  setSpawnAgentConfig(prevState => {
                    const newState = { ...prevState, providerType };
                    if (providerType === 'LMSTUDIO') {
                      newState.model = 'qwen3-30b-a3b';
                      newState.apiBaseUrl = 'http://192.168.13.6:1234';
                    } else {
                      // Reset model and apiBaseUrl for other providers if needed
                      // For now, we'll leave them as is or set to defaults if necessary
                      // Based on the initial state, 'gemini-2.5-pro-preview-05-06' is the default for GOOGLE
                       newState.model = 'gemini-2.5-pro-preview-05-06';
                       newState.apiBaseUrl = '';
                       newState.environmentVariables = '{"GEMINI_API_KEY":""}'
                    }
                    return newState;
                  });
                }}
                className={styles.formInput}
              >
                <option value="LMSTUDIO">LM Studio</option>
                <option value="GOOGLE">Google</option>
                {/* Add other providers here as they are supported */}
              </select>
            </div>

            {/* Show Advanced Checkbox */}
            <div className={styles.checkboxGroup}>
              <label htmlFor="showAdvanced" className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  id="showAdvanced"
                  checked={showAdvanced}
                  onChange={(e) => setShowAdvanced(e.target.checked)}
                  className={styles.checkboxInput}
                />
                Show Advanced Properties
              </label>
            </div>

            {/* Conditionally render advanced options */}
            {showAdvanced && (
              <>
                {/* LLM Model */}
                <div className={styles.formField}>
                  <label htmlFor="model" className={styles.formLabel}>LLM Model</label>
                  <input
                    type="text"
                    id="model"
                    name="model"
                    value={spawnAgentConfig.model}
                    onChange={(e) => setSpawnAgentConfig({ ...spawnAgentConfig, model: e.target.value })}
                    className={styles.formInput}
                  />
                </div>

                {/* API Base URL */}
                <div className={styles.formField}>
                  <label htmlFor="apiBaseUrl" className={styles.formLabel}>API Base URL</label>
                  <input
                    type="text"
                    id="apiBaseUrl"
                    name="apiBaseUrl"
                    value={spawnAgentConfig.apiBaseUrl}
                    onChange={(e) => setSpawnAgentConfig({ ...spawnAgentConfig, apiBaseUrl: e.target.value })}
                    className={styles.formInput}
                  />
                </div>

                {/* Agent Port */}
                <div className={styles.formField}>
                  <label htmlFor="port" className={styles.formLabel}>Agent Port (leave empty for random)</label>
                  <input
                    type="text" // Keep as text to allow empty string, validation handles number conversion
                    id="port"
                    name="port"
                    placeholder="e.g., 8081"
                    value={spawnAgentConfig.port}
                    onChange={(e) => {
                      const value = e.target.value;
                      // Allow only digits or empty string
                      if (value === '' || /^\d*$/.test(value)) {
                        setSpawnAgentConfig({ ...spawnAgentConfig, port: value });
                      }
                    }}
                    className={styles.formInput}
                  />
                </div>


                {/* Environment Variables */}
                <div className={styles.formField}>
                  <label htmlFor="environmentVariables" className={styles.formLabel}>Environment Variables (JSON)</label>
                  <textarea
                    id="environmentVariables"
                    name="environmentVariables"
                    placeholder='e.g., {"GEMINI_API_KEY": "YOUR_API_KEY"}'
                    value={spawnAgentConfig.environmentVariables}
                    onChange={(e) => setSpawnAgentConfig({ ...spawnAgentConfig, environmentVariables: e.target.value })}
                    rows={5}
                    className={styles.formTextarea}
                  />
                </div>
              
              </>
            )}

          

            {/* Submit Button */}
            <div className={styles.formField}>
              <button
                type="submit"
                className={`${styles.button} ${styles.buttonPrimary}`}
                disabled={isSpawning || isFetchingTools || isComposingPrompt || isUpdatingPrompt}
              >
                {isSpawning && <div className={styles.spinner}></div>}
                {isSpawning ? 'Spawning...' : 'Spawn Agent'}
              </button>
            </div>
          </div>
        </form>

        {/* Status Message */}
        {statusMessage && (
          <div className={`${styles.alert} ${messageType === 'success' ? styles.alertSuccess : messageType === 'error' ? styles.alertError : messageType === 'info' ? styles.alertInfo : ''}`}>
            {statusMessage}
          </div>
        )}

      </div>
    </div>
  );
};

export default AddLocalAgent;
