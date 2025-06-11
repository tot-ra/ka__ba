package main

import (
	"context" // Import the context package
	"flag"
	"fmt"
	"ka/a2a"
	"ka/llm"
	"ka/tools" // Import the tools package
	"log"      // Manually added back
	"os"
	// "os/user" // No longer needed here
	// "runtime" // No longer needed here
	"strconv" // Added for port conversion
	"strings" // Added for API key splitting
	// "time" // Removed unused import
)

const (
	model                   = "" // Consider making this configurable via flags/env
	apiURL                  = "" //"http://localhost:1234/v1/chat/completions"
	defaultMaxContextLength = 8192 // Increased default context length to accommodate long system prompt
)

var availableToolsMap map[string]tools.Tool

func main() {
	log.Printf("[main] Starting ka agent process.")
	log.Printf("[main] Parsing command line flags.")
	// Parse command line flags
	flags := parseFlags()
	log.Printf("[main] Flags parsed.")

	// Load available tools and get the McpTool instance
	availableToolsMap, mcpToolInstance := loadTools()

	// Determine port from flags and environment
	port := determinePort(flags.portFlag)

	// Check for "server" as a non-flag argument
	checkServerArg(&flags.serveFlag)

	// Get current working directory
	currentDir := getCurrentWorkingDirectory()

	if flags.serveFlag {
		runServerMode(flags, port, availableToolsMap, mcpToolInstance, currentDir) // Pass mcpToolInstance
	} else {
		runCLIMode(flags, availableToolsMap) // Pass flags struct
	}
}

// FlagOptions holds all command line flags and the user prompt
type FlagOptions struct {
	serveFlag            bool
	streamFlag           bool
	maxContextLengthFlag int
	modelFlag            string
	portFlag             int
	nameFlag             string
	descriptionFlag      string
	jwtSecretFlag        string
	apiKeysFlag          string
	mcpConfigFlag string // Add flag for MCP server configuration
	providerFlag  string // Add flag for LLM provider type
	userPrompt    string // Add field for user prompt
}

func parseFlags() FlagOptions {
	var flags FlagOptions

	flag.BoolVar(&flags.serveFlag, "serve", false, "Run the agent as an A2A HTTP server")
	flag.BoolVar(&flags.streamFlag, "stream", false, "Enable streaming output for CLI chat")
	flag.IntVar(&flags.maxContextLengthFlag, "max_context_length", defaultMaxContextLength, "Maximum context length for the LLM")
	flag.StringVar(&flags.modelFlag, "model", model, "LLM model to use")
	flag.IntVar(&flags.portFlag, "port", 8080, "Port for the A2A HTTP server")
	flag.StringVar(&flags.nameFlag, "name", "Default ka agent", "Name of the agent")
	flag.StringVar(&flags.descriptionFlag, "description", "A spawned ka agent instance.", "Description of the agent")
	flag.StringVar(&flags.jwtSecretFlag, "jwt-secret", "", "JWT secret key for securing endpoints (if provided, JWT auth is enabled)")
	flag.StringVar(&flags.apiKeysFlag, "api-keys", "", "Comma-separated list of valid API keys (if provided, API key auth is enabled)")
	flag.StringVar(&flags.mcpConfigFlag, "mcp-config", "", "Path to MCP server configuration file or JSON string") // Define the new flag
	flag.StringVar(&flags.providerFlag, "provider", "lmstudio", "LLM provider to use (e.g., 'lmstudio', 'google')") // Define the new provider flag

	flag.Parse() // The crash is happening here or immediately after

	log.Printf("[parseFlags] flag.Parse() completed.")

	// Capture the non-flag arguments as the user prompt
	args := flag.Args()
	if len(args) > 0 {
		flags.userPrompt = strings.Join(args, " ") // Join all arguments to handle multi-word prompts
	}

	// Redirect standard log output to stdout
	log.SetOutput(os.Stdout)

	return flags
}

// loadTools loads all available tools and returns the map and the McpTool instance.
func loadTools() (map[string]tools.Tool, *tools.McpTool) {
	log.Printf("[loadTools] Entering loadTools function.")
	availableToolsSlice := tools.GetAllTools()
	availableToolsMap := make(map[string]tools.Tool)
	var mcpToolInstance *tools.McpTool // Declare a variable to hold the McpTool instance

	for _, tool := range availableToolsSlice {
		availableToolsMap[tool.GetName()] = tool
		// Check if the tool is the McpTool and store its instance
		if mcpTool, ok := tool.(*tools.McpTool); ok {
			mcpToolInstance = mcpTool
		}
	}
	return availableToolsMap, mcpToolInstance
}

func determinePort(portFlag int) int {
	port := portFlag
	envPortStr := os.Getenv("PORT")
	if envPortStr != "" {
		envPort, err := strconv.Atoi(envPortStr)
		if err == nil {
			port = envPort
		} else {
			fmt.Fprintf(os.Stderr, "Warning: Invalid PORT environment variable '%s', using default/flag value: %d\n", envPortStr, port)
		}
	}
	return port
}

func checkServerArg(serveFlag *bool) {
	args := flag.Args()
	if len(args) > 0 && args[0] == "server" {
		*serveFlag = true
		flag.Set("args", "")
	}
}

func getCurrentWorkingDirectory() string {
	currentDir, err := os.Getwd()
	if err != nil {
		log.Printf("[main] Error getting current working directory: %v", err)
		currentDir = "unknown"
	}
	return currentDir
}

func runServerMode(flags FlagOptions, port int, availableToolsMap map[string]tools.Tool, mcpToolInstance *tools.McpTool, currentDir string) { // Removed environmentVariables
	log.Printf("[runServerMode] Entering server mode.")
	fmt.Println("[main] Starting in server mode...")

	log.Printf("[runServerMode] Initializing task store.")
	// Initialize task store
	taskStore := initializeTaskStore()
	log.Printf("[runServerMode] Task store initialized.")

	log.Printf("[runServerMode] Creating LLM client for server mode.")

	// Determine API URL based on provider and environment variable
	currentAPIURL := apiURL // Default for LM Studio
	if flags.providerFlag == "lmstudio" {
		envAPIURL := os.Getenv("apiBaseUrl")
		if envAPIURL != "" {
			currentAPIURL = envAPIURL
			log.Printf("[runServerMode] Using apiBaseUrl environment variable for LMStudio API URL: %s", currentAPIURL)
		} else {
			log.Printf("[runServerMode] apiBaseUrl environment variable not set, using default LMStudio API URL: %s", currentAPIURL)
		}
	} else if flags.providerFlag == "google" {
		// Google API key is handled within NewGoogleClient using GEMINI_API_KEY env var
		// No specific API URL needs to be set here for Google provider
		currentAPIURL = "" // Or some indicator that API URL is not configured via this field for Google
	}

	// Convert provider flag to lowercase for matching in NewClientFactory
	providerTypeLower := strings.ToLower(flags.providerFlag)
	log.Printf("[runServerMode] Using provider type: %s (originally %s)", providerTypeLower, flags.providerFlag)

	// Create LLM client for server mode using the factory
	llmConfig := llm.ClientConfig{
		"apiURL":           currentAPIURL, // Use determined API URL
		"model":            flags.modelFlag,
		"systemMessage":    "", // Initial system message for server mode
		"maxContextLength": flags.maxContextLengthFlag,
		// Google API key is now only read from GEMINI_API_KEY env var in NewGoogleClient
	}
	llmClient, err := llm.NewClientFactory(providerTypeLower, llmConfig, make(map[string]string)) // Pass lowercase provider type
	if err != nil {
		log.Fatalf("Failed to create LLM client for server mode: %v", err)
	}

	// Create TaskExecutor
	// Compose a default system message for the TaskExecutor in server mode
	// This includes the agent's identity, objective, communication style, and available tools.
	// A separate endpoint exists to update the system prompt dynamically.
	serverSystemMessage := composeCliSystemMessage(availableToolsMap) // Use the same composition logic as CLI mode
	taskExecutor := a2a.NewTaskExecutor(llmClient, taskStore, availableToolsMap, serverSystemMessage, flags.providerFlag)
	fmt.Printf("[main] TaskExecutor initialized with %d available tools.\n", len(availableToolsMap))
	log.Printf("[runServerMode] TaskExecutor initialized with system message:\n%s\n", serverSystemMessage) // Added logging

	// Process API keys
	apiKeys := processAPIKeys(flags.apiKeysFlag)

	// Start HTTP server
	startHTTPServer(
		taskExecutor,
		llmClient,
		port,
		flags.nameFlag,
		flags.descriptionFlag,
		flags.modelFlag,
		flags.jwtSecretFlag,
		apiKeys,
		availableToolsMap,
		mcpToolInstance,
	)
}

func initializeTaskStore() a2a.TaskStore {
	taskStoreDir := os.Getenv("TASK_STORE_DIR") // Consider making this configurable via flags
	if taskStoreDir == "" {
		fmt.Println("[main] TASK_STORE_DIR not set, using default task directory.")
	} else {
		fmt.Printf("[main] Using task directory from TASK_STORE_DIR: %s\n", taskStoreDir)
	}

	taskStore, err := a2a.NewFileTaskStore(taskStoreDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error initializing file task store: %v\n", err)
		os.Exit(1)
	}
	return taskStore
}

func processAPIKeys(apiKeysFlag string) []string {
	apiKeys := []string{}
	if apiKeysFlag != "" {
		keys := strings.Split(apiKeysFlag, ",")
		for _, key := range keys {
			trimmedKey := strings.TrimSpace(key)
			if trimmedKey != "" {
				apiKeys = append(apiKeys, trimmedKey)
			}
		}
	}
	return apiKeys
}

func runCLIMode(flags FlagOptions, availableToolsMap map[string]tools.Tool) { // Accept FlagOptions struct
	// Warn about auth flags in CLI mode
	warnAboutAuthFlags(flags.jwtSecretFlag, flags.apiKeysFlag)

	fmt.Println("[main] Starting in CLI chat mode...")

	// Determine if streaming should be enabled
	stream := determineStreamFlag(flags.streamFlag)

	// User prompt is now available directly in the flags struct
	userPrompt := flags.userPrompt

	// Check if user prompt is empty and print usage if so
	if userPrompt == "" {
		printUsageAndExit()
	}

	// Compose system prompt with all available tools
	cliSystemMessage := composeCliSystemMessage(availableToolsMap)

	// Create LLM client for CLI mode using the factory
	cliLLMConfig := llm.ClientConfig{
		"apiURL":           apiURL, // Default API URL for LM Studio
		"model":            flags.modelFlag,
		"systemMessage":    cliSystemMessage, // System message for CLI mode
		"maxContextLength": flags.maxContextLengthFlag,
		// Google API key is now only read from GEMINI_API_KEY env var in NewGoogleClient
	}
	cliLLMClient, err := llm.NewClientFactory(flags.providerFlag, cliLLMConfig, make(map[string]string)) // Pass an empty map for env vars
	if err != nil {
		log.Fatalf("Failed to create LLM client for CLI mode: %v", err)
	}

	// Send prompt to LLM and handle response
	sendPromptToLLM(cliLLMClient, cliSystemMessage, userPrompt, stream)
}

func warnAboutAuthFlags(jwtSecretFlag, apiKeysFlag string) {
	if jwtSecretFlag != "" || apiKeysFlag != "" {
		fmt.Fprintln(os.Stderr, "Warning: --jwt-secret and --api-keys flags are only used in server mode (--serve or 'server' argument).")
	}
}

func determineStreamFlag(streamFlag bool) bool {
	stream := streamFlag
	if os.Getenv("LLM_STREAM") == "true" {
		stream = true
	}
	return stream
}


func printUsageAndExit() {
	fmt.Fprintln(os.Stderr, "Error: No prompt provided via arguments or stdin.")
	fmt.Fprintln(os.Stderr, "Usage: ka [options] \"Your prompt here\"")
	fmt.Fprintln(os.Stderr, "   or: echo \"Your prompt here\" | ka [options]")
	fmt.Fprintln(os.Stderr, "Options:")
	flag.PrintDefaults()
	os.Exit(1)
}

func composeCliSystemMessage(availableToolsMap map[string]tools.Tool) string {
	var allToolNames []string
	for name := range availableToolsMap {
		allToolNames = append(allToolNames, name)
	}

	// System context is now fetched within ComposeSystemPrompt
	// In CLI mode, no MCP servers are selected, so pass an empty slice of McpServerConfig.
	cliSystemMessage := tools.ComposeSystemPrompt(allToolNames, []tools.McpServerConfig{}, availableToolsMap)
	log.Printf("[main] Composed CLI system message: %s", cliSystemMessage) // Added logging
	fmt.Printf("[main] Using CLI system message:\n%s\n", cliSystemMessage)
	return cliSystemMessage
}

func sendPromptToLLM(cliLLMClient llm.LLMClient, cliSystemMessage, userPrompt string, stream bool) {
	messages := []llm.Message{
		{Role: "system", Content: cliSystemMessage},
		{Role: "user", Content: userPrompt},
	}

	fmt.Println("[main] Sending prompt to LLM...")
	completion, inputTokens, completionTokens, err := cliLLMClient.Chat(context.Background(), messages, stream, os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "LLM error:", err)
		os.Exit(1)
	}

	// Log token usage
	fmt.Fprintf(os.Stderr, "\n[CLI Mode] Input Tokens: %d, Completion Tokens: %d\n", inputTokens, completionTokens)

	// Print final completion if not streaming
	if !stream && completion != "" {
		fmt.Println(completion)
	}
}

func isTerminal(f *os.File) bool {
	fileInfo, err := f.Stat()
	if err != nil {
		return false
	}
	return (fileInfo.Mode() & os.ModeCharDevice) != 0
}
