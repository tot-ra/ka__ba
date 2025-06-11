import { spawn, ChildProcess, exec } from 'child_process'; // Add exec
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Agent, AgentRegistry } from './agentRegistry.js';
import { PortManager } from './portManager.js';
import { LogManager } from './logManager.js';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'fs'; // Import fs.promises for async file operations
import os from 'os'; // Import os module for temporary directory

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SpawnedProcessInfo {
  process: ChildProcess;
  pid: number; // This might be the docker process PID, or we might need container ID
  port: number;
  config: {
    model?: string;
    systemPrompt?: string;
    apiBaseUrl?: string;
    executionMode: 'BARE_HOST' | 'DOCKERIZED'; // Add executionMode
    scopePath?: string; // Add scopePath
    environmentVariables?: { [key: string]: any }; // Add environmentVariables
  };
  containerId?: string; // Optional: store container ID
}

export class LocalAgentManager {
  private spawnedProcesses: Map<string, SpawnedProcessInfo> = new Map();
  private agentRegistry: AgentRegistry;
  private portManager: PortManager;
  private logManager: LogManager;
  private eventEmitter: EventEmitter;

  constructor(agentRegistry: AgentRegistry, portManager: PortManager, logManager: LogManager, eventEmitter: EventEmitter) {
    this.agentRegistry = agentRegistry;
    this.portManager = portManager;
    this.logManager = logManager;
    this.eventEmitter = eventEmitter;
  }

  public async spawnLocalAgent(args: {
    model?: string;
    systemPrompt?: string;
    apiBaseUrl?: string;
    port?: number | null;
    name?: string;
    description?: string;
    providerType?: string;
    environmentVariables?: { [key: string]: any };
    executionMode: 'BARE_HOST' | 'DOCKERIZED'; // Add executionMode
    scopePath?: string; // Add scopePath
  }): Promise<Agent | null> {
    const {
      model,
      systemPrompt,
      apiBaseUrl,
      port: requestedPort,
      name,
      description,
      providerType,
      environmentVariables,
      executionMode, // Destructure new parameter
      scopePath, // Destructure new parameter
    } = args;
    console.log('Attempting to spawn ka agent with:', { ...args  }); // Log args

    let agentPort: number;
    try {
      agentPort = await this.portManager.determinePort(requestedPort);
    } catch (error: any) {
      console.error("Failed to determine port for ka agent:", error);
      return null;
    }

    const agentUrl = `http://localhost:${agentPort}`;
    console.log(`Attempting to spawn ka agent at ${agentUrl} using PORT=${agentPort}`);

    // Assign a unique ID to the new agent *before* spawning so we can use it for the task directory
    const newAgentId = this.agentRegistry.getNextAgentId();

    // Create a unique task store directory in a temporary location
    // This directory will be on the HOST, even for Dockerized mode,
    // so the backend can access task files.
    const tempDir = os.tmpdir();
    const taskStoreDir = join(tempDir, `ka_tasks_${newAgentId}`);
    try {
      await fs.mkdir(taskStoreDir, { recursive: true });
      console.log(`Created task store directory for agent ${newAgentId}: ${taskStoreDir}`);
    } catch (error: any) {
      console.error(`Failed to create task store directory ${taskStoreDir}:`, error);
      return null; // Fail spawning if directory creation fails
    }



    // Set the TASK_STORE_DIR environment variable for the spawned process
    // This needs to be the path *visible to the agent process*.
    // For bare host, it's the host path. For Docker, it's the path inside the container.
    const agentTaskStoreDir = executionMode === 'DOCKERIZED' ? '/app/_tasks' : taskStoreDir; // Assuming /app/_tasks inside container
    console.log(`Setting TASK_STORE_DIR for agent ${newAgentId} (inside agent): ${agentTaskStoreDir}`);


    const processEnv: NodeJS.ProcessEnv = { ...process.env }; // Start with an empty object
    if (environmentVariables) {
      for (const key in environmentVariables) {
        if (Object.prototype.hasOwnProperty.call(environmentVariables, key)) {
          // Ensure value is a string
          processEnv[key] = String(environmentVariables[key]);
        }
      }
    }
    // Add other necessary env vars like PORT and TASK_STORE_DIR
    processEnv.PORT = agentPort.toString();
    processEnv.TASK_STORE_DIR = agentTaskStoreDir; // Use the agent's view of the path
    processEnv.apiBaseUrl = apiBaseUrl;

    let kaProcess: ChildProcess;
    let processPid: number | undefined;
    let containerId: string | undefined;

    if (executionMode === 'DOCKERIZED') {
        if (!scopePath) {
            console.error(`Scope path is required for Dockerized execution mode.`);
            // Clean up the created taskStoreDir on the host
            try {
                await fs.rm(taskStoreDir, { recursive: true, force: true });
                console.log(`Cleaned up task store directory ${taskStoreDir}`);
            } catch (cleanupError) {
                console.error(`Failed to clean up task store directory ${taskStoreDir}:`, cleanupError);
            }
            return null;
        }

        console.log(`Spawning ka agent in Dockerized mode with scope: ${scopePath}`);

        // Construct the docker run command
        const dockerArgs = [
            'run',
            '-d', // Run in detached mode to get container ID immediately
            '--rm', // Automatically remove the container when it exits
            '-p', `${agentPort}:${agentPort}`, // Publish the agent's port
            '-v', `${scopePath}:/app/sandbox`, // Mount the scope path
            '-v', `${taskStoreDir}:/app/_tasks`, // Mount the host task store directory
        ];

        // Add environment variables to the docker run command
        for (const key in processEnv) {
            if (Object.prototype.hasOwnProperty.call(processEnv, key) && processEnv[key] !== undefined) {
                 dockerArgs.push('-e', `${key}=${processEnv[key]}`);
            }
        }

        dockerArgs.push('ka-agent'); // The Docker image name

        // Command to run inside the container (the ka server command)
        const containerCommand = ['/app/ka', 'server']; // Assuming ka is at /app/ka in the image

        const fullDockerCommand = ['docker', ...dockerArgs, ...containerCommand];
        console.log('Executing docker run command:', fullDockerCommand.join(' '));

        // Use spawn to run the docker command, explicitly listing command and args
        kaProcess = spawn('docker', [...dockerArgs, ...containerCommand], {
            stdio: ['ignore', 'pipe', 'pipe'], // Capture stdout and stderr
        });

        // In detached mode, stdout will be the container ID
        const containerIdPromise = new Promise<string>((resolve, reject) => {
            let id = '';
            if (!kaProcess.stdout) {
                reject(new Error('Failed to get stdout from docker run process.'));
                return;
            }
            kaProcess.stdout.on('data', (data) => {
                id += data.toString();
            });
            let stderrOutput = '';
            if (kaProcess.stderr) { // Add null check
                kaProcess.stderr.on('data', (data) => {
                    stderrOutput += data.toString();
                });
            }

            kaProcess.on('close', (code) => {
                if (code === 0) {
                    resolve(id.trim());
                } else {
                    reject(new Error(`docker run failed with code ${code}. Stdout: ${id}. Stderr: ${stderrOutput}`));
                }
            });
             kaProcess.on('error', (err) => {
                reject(err);
            });
        });

        try {
            containerId = await containerIdPromise;
            console.log(`Docker container started with ID: ${containerId}`);

            // Now, attach to the container's logs to capture stdout/stderr
            // This requires a separate docker logs process
            const logProcess = spawn('docker', ['logs', '-f', containerId], {
                 stdio: ['ignore', 'pipe', 'pipe'],
            });
            kaProcess = logProcess; // Use the log process for log capturing and exit handling
            processPid = logProcess.pid; // Use the log process PID

        } catch (error: any) {
            console.error("Failed to start Docker container:", error);
             // Clean up the created taskStoreDir on the host
            try {
                await fs.rm(taskStoreDir, { recursive: true, force: true });
                console.log(`Cleaned up task store directory ${taskStoreDir}`);
            } catch (cleanupError) {
                console.error(`Failed to clean up task store directory ${taskStoreDir}:`, cleanupError);
            }
            return null;
        }


    } else { // BARE_HOST execution mode
        console.log(`Spawning ka agent in Bare Host mode.`);
        const kaExecutablePath = join(__dirname, '..', '..', '..', 'ka', 'ka');
        console.log(`Calculated absolute path for ka executable: ${kaExecutablePath}`);

        const kaArgs = [];
        if (name) kaArgs.push('--name', name);
        if (description) kaArgs.push('--description', description);
        if (model) kaArgs.push('--model', model);
        if (systemPrompt) kaArgs.push('--system-prompt', systemPrompt);
        if (providerType) kaArgs.push('--provider', providerType);
        kaArgs.push('server');
        console.log('Spawning ka with args:', kaArgs);

        kaProcess = spawn(kaExecutablePath, kaArgs, {
          env: processEnv, // Use the constructed environment variables
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // cwd: '/path/to/writable/directory', // Maybe set cwd to taskStoreDir?
        });
        kaProcess.unref(); // Allow the Node.js process to exit independently

        processPid = kaProcess.pid;
    }


    try {
      // Use the appropriate process (docker logs or ka process) for waiting and logging
      const processToWatch = executionMode === 'DOCKERIZED' ? kaProcess : kaProcess; // In Dockerized, kaProcess is now the logProcess

      const newAgent = await this.waitForAgentStartup(newAgentId, processToWatch, agentPort, agentUrl, name, description, model, systemPrompt, apiBaseUrl);

      this.agentRegistry.addAgent(newAgent);

      if (typeof processPid === 'number') { // Use processPid which is set for both modes
        this.spawnedProcesses.set(newAgent.id, {
          process: processToWatch, // Store the process being watched for logs/exit
          pid: processPid,
          port: agentPort,
          config: { ...args, environmentVariables: undefined }, // Store config, exclude large env vars
          containerId: containerId, // Store container ID if Dockerized
        });
        console.log(`Stored spawned process info for agent ID: ${newAgent.id} with PID: ${processPid} on port ${agentPort}`);
        if (containerId) {
             console.log(`(Docker Container ID: ${containerId})`);
        }

        this.setupOngoingLogCapture(processToWatch, newAgent.id); // Use the process being watched

      } else {
         console.error(`Process started for agent ${newAgentId} but PID is missing.`);
         if (executionMode === 'DOCKERIZED' && containerId) {
             // Attempt to stop the container if PID is missing but container ID is known
             console.log(`Attempting to stop Docker container ${containerId} due to missing PID.`);
             exec(`docker stop ${containerId}`, (err, stdout, stderr) => {
                 if (err) console.error(`Error stopping container ${containerId}:`, err);
                 if (stdout) console.log(`docker stop stdout:`, stdout);
                 if (stderr) console.error(`docker stop stderr:`, stderr);
             });
         } else if (kaProcess && !kaProcess.killed) {
             kaProcess.kill();
         }
         this.agentRegistry.removeAgent(newAgent.id);
         // Clean up the created taskStoreDir on the host
            try {
                await fs.rm(taskStoreDir, { recursive: true, force: true });
                console.log(`Cleaned up task store directory ${taskStoreDir}`);
            } catch (cleanupError) {
                console.error(`Failed to clean up task store directory ${taskStoreDir}:`, cleanupError);
            }
         throw new Error('Process started but PID is missing.');
      }

      this.setupProcessExitHandler(processToWatch, newAgent.id); // Use the process being watched
      return newAgent;

    } catch (error: unknown) {
      console.error("Error during spawnLocalAgent execution:", error);
      // Attempt to clean up the process/container if an error occurred after spawning but before successful startup
      if (executionMode === 'DOCKERIZED' && containerId) {
             console.log(`Attempting to stop Docker container ${containerId} due to startup error.`);
             exec(`docker stop ${containerId}`, (err, stdout, stderr) => {
                 if (err) console.error(`Error stopping container ${containerId}:`, err);
                 if (stdout) console.log(`docker stop stdout:`, stdout);
                 if (stderr) console.error(`docker stop stderr:`, stderr);
             });
      } else if (kaProcess && !kaProcess.killed) {
        console.log("Ensuring failed kaProcess is killed.");
        kaProcess.kill();
      }
       // Clean up the created taskStoreDir on the host
        try {
            await fs.rm(taskStoreDir, { recursive: true, force: true });
            console.log(`Cleaned up task store directory ${taskStoreDir}`);
        } catch (cleanupError) {
            console.error(`Failed to clean up task store directory ${taskStoreDir}:`, cleanupError);
        }
      return null;
    }
  }

  private setupProcessExitHandler(processToWatch: ChildProcess, agentId: string): void {
    processToWatch.on('exit', (code: number | null, signal: string | null) => {
      console.log(`Spawned agent process (ID: ${agentId}) exited after successful start with code ${code}, signal ${signal}.`);
      // Note: For Dockerized mode, this is the exit of the 'docker logs -f' process,
      // which happens when the container stops.
      this.cleanupAgentData(agentId);
    });
    processToWatch.on('error', (err: Error) => {
      console.error(`Error on spawned agent process (ID: ${agentId}):`, err);
      // This might catch errors like 'docker logs' failing to attach
      this.cleanupAgentData(agentId); // Clean up on process error
    });
  }


  public getSpawnedProcessInfo(agentId: string): SpawnedProcessInfo | undefined {
    return this.spawnedProcesses.get(agentId);
  }

  public stopLocalAgent(id: string): boolean {
    console.log(`Attempting to stop ka agent with ID: ${id}`);
    const spawnedProcessInfo = this.spawnedProcesses.get(id);

    if (!spawnedProcessInfo) {
      console.log(`No spawned process found for agent ID: ${id}`);
      const agent = this.agentRegistry.findAgent(id);
      if (agent && agent.isLocal) {
        console.log(`Agent ${id} found in registry but not in spawned processes. Removing from registry.`);
        this.agentRegistry.removeAgent(id);
        this.logManager.removeAgentLogs(id);
        // TODO: Clean up task store directory on host? This is tricky if process info is lost.
        return true;
      }
      return false;
    }

    return this.stopLocalAgentProcess(id, spawnedProcessInfo);
  }

  private stopLocalAgentProcess(agentId: string, info: SpawnedProcessInfo): boolean {
    if (info.config.executionMode === 'DOCKERIZED' && info.containerId) {
      console.log(`Stopping Docker container with ID: ${info.containerId} for agent ID: ${agentId}`);
      // Use docker stop for Dockerized mode
      exec(`docker stop ${info.containerId}`, (err, stdout, stderr) => {
        if (err) {
          console.error(`Failed to stop Docker container ${info.containerId}: ${err}`);
          // If stop fails, try kill
          console.log(`Attempting to kill Docker container ${info.containerId}`);
          exec(`docker kill ${info.containerId}`, (killErr, killStdout, killStderr) => {
            if (killErr) console.error(`Failed to kill Docker container ${info.containerId}: ${killErr}`);
            if (killStdout) console.log(`docker kill stdout:`, killStdout);
            if (killStderr) console.error(`docker kill stderr:`, killStderr);
            this.cleanupAgentData(agentId); // Clean up regardless of kill success
          });
        } else {
          console.log(`Successfully stopped Docker container ${info.containerId}.`);
          if (stdout) console.log(`docker stop stdout:`, stdout);
          this.cleanupAgentData(agentId);
        }
      });
      return true; // Assume success for now, cleanup happens in callback
    } else if (typeof info.pid === 'number') { // BARE_HOST mode
      console.log(`Stopping process with PID: ${info.pid} for agent ID: ${agentId}`);
      try {
        process.kill(info.pid);
        console.log(`Sent kill signal to process with PID: ${info.pid}`);
        this.cleanupAgentData(agentId);
        return true;
      } catch (err: any) {
        console.error(`Failed to stop process with PID ${info.pid}: ${err}`);
        if (err.code === 'ESRCH') {
          console.log(`Process with PID ${info.pid} not found (ESRCH). Assuming already stopped.`);
          this.cleanupAgentData(agentId);
          return true;
        }
        return false;
      }
    } else {
      console.error(`Invalid or missing PID/Container ID for agent ID: ${agentId}. Cannot stop process.`);
      this.cleanupAgentData(agentId);
      return false;
    }
  }

  private cleanupAgentData(agentId: string): void {
    this.spawnedProcesses.delete(agentId);
    this.agentRegistry.removeAgent(agentId);
    this.logManager.removeAgentLogs(agentId);
    // TODO: Clean up the task store directory on the host!
    // This requires knowing the taskStoreDir path, which is currently stored
    // in the spawnedProcesses map, but that's deleted here.
    // We need a way to reliably get the taskStoreDir for cleanup.
    // Maybe store it in the AgentRegistry or a separate map?
  }

  private setupOngoingLogCapture(processToWatch: ChildProcess, agentId: string): void {
    const handleData = (data: Buffer, stream: 'stdout' | 'stderr') => {
      const rawData = data.toString();
      const lines = rawData.split('\n');
      lines.forEach((line, index) => {
        if (line || (index === lines.length - 1 && lines.length > 1)) {
          this.logManager.addLog(agentId, line, stream);
        }
      });
    };

    processToWatch.stdout?.on('data', (data: Buffer) => handleData(data, 'stdout'));
    processToWatch.stderr?.on('data', (data: Buffer) => handleData(data, 'stderr'));
  }

  private waitForAgentStartup(
    agentId: string,
    processToWatch: ChildProcess, // Accept the process to watch (docker logs or ka process)
    agentPort: number,
    agentUrl: string,
    name: string | undefined,
    description: string | undefined,
    model: string | undefined,
    systemPrompt: string | undefined,
    apiBaseUrl: string | undefined
  ): Promise<Agent> {
    return new Promise<Agent>((resolve, reject) => {
      let resolved = false;
      let processError: Error | null = null;
      const startupTimeoutDuration = 15000;

      const cleanupTimeout = (timeoutId: NodeJS.Timeout) => {
        clearTimeout(timeoutId);
        processToWatch.stdout?.removeAllListeners('data');
        processToWatch.stderr?.removeAllListeners('data');
        processToWatch.removeAllListeners('error');
        processToWatch.removeAllListeners('exit');
        processToWatch.removeAllListeners('close');
      };

      const handleStartupError = (errorMsg: string, timeoutId: NodeJS.Timeout, err?: Error) => {
        if (resolved) return;
        resolved = true;
        cleanupTimeout(timeoutId);
        console.error(`ka agent startup failed: ${errorMsg}`, err || '');
        // Note: Killing processToWatch here might kill the docker logs process,
        // but not the container itself. Stopping the container needs to be handled
        // by the caller or a separate cleanup mechanism.
        reject(new Error(`Failed to spawn agent: ${errorMsg}`));
      };

      const startupTimeout = setTimeout(() => {
        handleStartupError(`Startup timeout (${startupTimeoutDuration}ms). Agent did not confirm successful start.`, startupTimeout);
      }, startupTimeoutDuration);

      const startupStdoutListener = (data: Buffer) => {
        const output = data.toString();
        // Look for the agent's specific startup message
        if (output.includes(`Agent server running at http://localhost:${agentPort}/`) && !resolved) {
          resolved = true;
          cleanupTimeout(startupTimeout);
          console.log(`ka agent on port ${agentPort} started successfully.`);
          const newAgent: Agent = {
            id: agentId,
            url: agentUrl,
            name: name || `Spawned ka Agent ${agentId}`,
            description: description || `ka agent spawned with model: ${model || 'default'}`,
            isLocal: true,
          };
          resolve(newAgent);
        }
      };
      const startupStderrListener = (data: Buffer) => {
        const output = data.toString();
        if (output.includes('address already in use') && output.includes(`:${agentPort}`)) {
          handleStartupError(`Port ${agentPort} already in use.`, startupTimeout);
        }
        // Capture other stderr output as potential error context
        processError = new Error(output.trim());
      };

      processToWatch.stdout?.on('data', startupStdoutListener);
      processToWatch.stderr?.on('data', startupStderrListener);

      processToWatch.on('error', (err: Error) => {
        handleStartupError(`Process error: ${err.message}`, startupTimeout, err);
      });

      processToWatch.on('exit', (code: number | null, signal: string | null) => {
        console.log(`Process (port ${agentPort}) exited with code ${code} and signal ${signal}.`);
        if (!resolved) {
          const exitMsg = `Process exited prematurely with code ${code}, signal ${signal}.`;
          handleStartupError(exitMsg, startupTimeout, processError || undefined);
        }
      });
    });
  }
}
