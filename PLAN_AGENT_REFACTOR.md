# Agent System Refactor: Data-Driven Agent Registry + Model Resolution

## Problem

Current Gaud agent system is hardcoded and brittle:

- **`POPULAR_AGENT_ORDER` / `DEFAULT_AGENTS`** — hardcoded string arrays
- **`AGENT_COMMAND_CANDIDATES`** — hardcoded command-to-agent mapping
- **`suggestedModelsForAgent()`** — hardcoded model suggestions
- **`agentCommand()`** — hardcoded per-agent invocation logic (if claude → `--dangerously-skip-permissions --print`, if codex → `--yolo`, etc.)
- **`resolveAgentCommand()`** — simple `command -v` check, no capability detection
- **`detectInstalledAgents()`** — iterates hardcoded list, no real provider detection
- **`chooseRoleAgents()`** — wizard-driven manual assignment, not data-driven
- Model selection is just `--model <string>` flag, no fallback chain
- Single 2944-line `index.ts` — everything in one file

## Target (inspired by oh-my-openagent)

oh-my-openagent's approach:

1. **Agent definitions are data** — each agent has `fallbackChain`, `model`, `temperature`, `tools`, `skills`, `mode` (primary/subagent), `category`, `description`. All defined as config objects.
2. **8 agent sources** — built-in, user config, project config, plugin, Claude Code agents, agent definition files, etc.
3. **4-step model resolution pipeline** — UI override → config override → category default → provider fallback chain → system default
4. **Fuzzy matching** — normalized model name matching against available models
5. **Provider cache** — tracks which providers are connected and what models they offer
6. **Agent config is declarative JSONC** — validated with Zod, not a wizard
7. **Agent factory pattern** — `createXXXAgent(model)` returns `AgentConfig`, not inline per-agent command building

## Refactoring Milestones

### Milestone 1: Agent Registry Module (`extensions/gaud/agent-registry.ts`)

Extract agent definitions from inline code into a proper registry.

**Files:**
- `extensions/gaud/agent-registry.ts` (NEW)
- `extensions/gaud/agent-types.ts` (NEW)

**Design:**

```typescript
// agent-types.ts
export type AgentCapability = "code" | "review" | "design" | "research" | "plan" | "delegate" | "search" | "vision";

export type AgentMode = "primary" | "subagent";

export type FallbackEntry = {
  model: string;
  providers: string[];
  variant?: string;
};

export type AgentDefinition = {
  name: string;
  displayName: string;
  description: string;
  capabilities: AgentCapability[];
  mode: AgentMode;
  commandCandidates: string[];
  fallbackChain: FallbackEntry[];
  defaultModel?: string;
  defaultVariant?: string;
  temperature?: number;
  supportedModelFlags?: string[];
  category?: string;
};

export type AgentDiscovery = {
  name: string;
  command: string;
  definition: AgentDefinition;
  version?: string;
};

export type ModelResolutionRequest = {
  agent: AgentDefinition;
  userModel?: string;
  availableModels: Set<string>;
  connectedProviders: string[];
};

export type ModelResolutionResult = {
  model: string;
  provider: string;
  provenance: "user" | "category-default" | "fallback-1" | "fallback-2" | "system-default";
  variant?: string;
};

// agent-registry.ts
const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  claude: {
    name: "claude",
    displayName: "Claude",
    description: "Anthropic Claude — strong general reasoning, precise plan-following, excellent reviewer",
    capabilities: ["code", "review", "research", "plan", "design"],
    mode: "primary",
    commandCandidates: ["claude"],
    fallbackChain: [
      { model: "claude-sonnet-4-6", providers: ["anthropic"], variant: "max" },
      { model: "claude-opus-4-7", providers: ["anthropic"] },
    ],
    supportedModelFlags: ["--model"],
  },
  codex: {
    name: "codex",
    displayName: "Codex",
    description: "Codex — OpenAI's code-focused agent, quick iterations",
    capabilities: ["code"],
    mode: "primary",
    commandCandidates: ["codex"],
    fallbackChain: [
      { model: "gpt-4o", providers: ["openai"] },
      { model: "gpt-4o-mini", providers: ["openai"] },
    ],
    supportedModelFlags: ["--model"],
  },
  // ... etc
};

export function discoverAgents(availableCommands: string[]): AgentDiscovery[] {
  // Match available commands to agent definitions
}

export function resolveModel(
  request: ModelResolutionRequest,
  options?: { log?: (msg: string) => void }
): ModelResolutionResult {
  // 4-step pipeline
}
```

**Done criteria:**
- [ ] `agent-types.ts` defines all types (AgentDefinition, FallbackEntry, etc.)
- [ ] `agent-registry.ts` defines all built-in agents as data
- [ ] `AgentRegistry` class provides: `discoverAgents()`, `getAgent()`, `getCapableAgents()`, `resolveModel()`
- [ ] All hardcoded agent constants from `index.ts` are removed
- [ ] `agentCommand()` moved to registry, uses definition data instead of if/else

### Milestone 2: Model Resolution Pipeline (`extensions/gaud/model-resolver.ts`)

Extract the oh-my-openagent-style 4-step pipeline.

**Files:**
- `extensions/gaud/model-resolver.ts` (NEW)

**Pipeline:**
1. User override (explicit `--model` flag) → highest priority
2. Category default (agent's role-based category default) 
3. Provider fallback chain (try each fallback entry, checking if provider is connected)
4. System default (hardcoded per-agent safe fallback)

Includes:
- Provider detection (what APIs do the agent CLIs have access to?)
- Model availability checking (what models can each provider serve?)
- Fuzzy model matching (normalize + includes)

**Done criteria:**
- [ ] `resolveModelPipeline()` implements 4-step resolution
- [ ] `fuzzyMatchModel()` implements normalized matching
- [ ] `ProviderCache` tracks connected providers
- [ ] Unit tests for resolution ordering

### Milestone 3: Provider Detection (`extensions/gaud/provider-detector.ts`)

Detect what LLM providers are available to installed agents.

**Files:**
- `extensions/gaud/provider-detector.ts` (NEW)
- `extensions/gaud/provider-cache.ts` (NEW)

**Design:**
```typescript
export type ProviderInfo = {
  id: string;
  name: string;
  agents: string[]; // which agent CLIs can use this provider
};

const KNOWN_PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: { id: "anthropic", name: "Anthropic", agents: ["claude"] },
  openai: { id: "openai", name: "OpenAI", agents: ["codex"] },
  google: { id: "google", name: "Google", agents: ["gemini", "antigravity"] },
  opencode: { id: "opencode", name: "OpenCode", agents: ["opencode"] },
};

export async function detectConnectedProviders(discoveries: AgentDiscovery[]): Promise<string[]> {
  // Check API keys, env vars, and agent configs to determine what providers are connected
}

export function getModelsForProvider(provider: string): string[] {
  // Static model lists, or dynamic from the agent
}
```

**Done criteria:**
- [ ] Provider definitions as data
- [ ] `detectConnectedProviders()` checks env vars and agent configs
- [ ] Provider cache persists detected providers

### Milestone 4: Refactor `index.ts` — Extract Agent Logic

**Files:**
- `extensions/gaud/agent-launcher.ts` (NEW) — replaces `agentCommand()` and `workerPrompt()`
- `extensions/gaud/agent-config.ts` (NEW) — replaces `loadGaudConfig()`, `chooseRoleAgents()`, etc.
- `extensions/gaud/index.ts` (EDITED) — slimmed down, delegates to new modules

**What moves out of index.ts:**
1. Agent command building → `agent-launcher.ts`
2. Agent config/selection → `agent-config.ts`
3. Agent detection → `agent-registry.ts`
4. Model resolution → `model-resolver.ts`
5. Provider detection → `provider-detector.ts`

**What stays in index.ts:**
1. Dashboard UI components
2. Polling loop
3. Tmux lifecycle
4. Event routing
5. Command/tool registration
6. GAUDMODE message handling

**Done criteria:**
- [ ] `index.ts` is under 2000 lines
- [ ] No hardcoded agent lists remain in `index.ts`
- [ ] `agentCommand()` replaced with `AgentLauncher.buildCommand()`
- [ ] `chooseRoleAgents()` replaced with config-file-driven agent assignment
- [ ] `detectInstalledAgents()` replaced with `AgentRegistry.discoverAgents()`

### Milestone 5: Config Format — Declarative Agent Config

Switch from wizard-driven config to declarative JSONC with fallback.

**Files:**
- `extensions/gaud/config-schema.ts` (NEW) — Zod schema for `.gaud/gaud.config.jsonc`
- `extensions/gaud/config-loader.ts` (NEW) — multi-level load (global, project, default)

**Config format:**
```jsonc
{
  "orchestrator": { "type": "pi", "agent": "pi" },
  "agents": {
    "claude": {
      "category": "primary",          // role category
      "model": "claude-sonnet-4-6",    // override default
      "fallback_models": [
        "claude-opus-4-7",
        { "model": "gpt-4o", "variant": "high" }
      ]
    },
    "codex": {
      "category": "implementer",
      "model": "gpt-4o"
    }
  },
  "categories": {
    "implementer": {
      "model": "claude-sonnet-4-6",
      "temperature": 0.1,
      "fallback_models": ["gpt-4o", "gemini-3.1-pro"]
    },
    "reviewer": {
      "model": "claude-opus-4-7",
      "temperature": 0.3
    },
    "designer": {
      "model": "gpt-4o",
      "temperature": 0.5
    },
    "researcher": {
      "model": "gpt-4o-mini",
      "temperature": 0.1
    }
  },
  "promptSources": { /* existing */ }
}
```

**Done criteria:**
- [ ] Zod schema validates config
- [ ] Multi-level load: global → project → defaults
- [ ] Category inheritance works (agents inherit from categories)
- [ ] Existing config files are auto-migrated
- [ ] `/gaud setup` updated to write JSONC config instead of interactive wizard

### Milestone 6: Agent Capability-Based Role Assignment

Replace manual role assignment with capability matching.

**Files:**
- `extensions/gaud/role-planner.ts` (NEW) — matches plan workstreams to capable agents

**Design:**
```typescript
export type RoleRequirement = {
  role: string;
  requiredCapabilities: AgentCapability[];
  minAgents: number;
  preferDistinctAgents: boolean;
};

export function assignRoles(
  workers: WorkerPlan[],
  discoveries: AgentDiscovery[],
  categories: Record<string, AgentCategoryConfig>,
): Map<string, AgentDiscovery> {
  // For each worker, find the best agent match by:
  // 1. Required capabilities
  // 2. Mode fit (primary vs subagent)
  // 3. Category model preference
  // 4. Minimize agent duplication across parallel workers
}
```

**Done criteria:**
- [ ] `assignRoles()` maps workstreams to optimal agents
- [ ] Prefers different agents for parallel work (diversity)
- [ ] Falls back gracefully when no perfect match exists
- [ ] Used by `gaud_start_run` tool

### Milestone 7: Integration — Wire Everything Together

**Files:**
- `extensions/gaud/index.ts` (EDITED) — final slim down
- `extensions/gaud/agent-registry.ts` (EDITED) — final wiring

**Changes:**
1. `gaud_start_run` tool uses `role-planner.ts` for automatic agent assignment
2. Model resolution uses `model-resolver.ts` with fallback chains
3. Agent detection uses `agent-registry.ts` with dynamic discovery
4. `/gaud setup` writes declarative JSONC config with Zod validation
5. Old wizard-only flow is deprecated in favor of config-first

**Done criteria:**
- [ ] Full end-to-end test: install, config, detect agents, assign roles, launch
- [ ] Backward compatible: existing configs load correctly
- [ ] Agent auto-detection works without explicit config
- [ ] Model fallback works when preferred model isn't available

## Key Design Principles

1. **Agents as data, not code.** Agent definitions are static config objects, not scattered across `if/else` branches.
2. **Declarative over wizard.** Users write JSONC configs; the interactive wizard is a fallback for first-run.
3. **Fallback chains everywhere.** Every model resolution has a fallback. Never a single hardcoded model.
4. **Capability-based, not name-based.** Agents declare capabilities; roles require capabilities; matching is automated.
5. **Provider-aware.** Resolution knows which providers are connected and adjusts accordingly.
6. **Fuzzy matching.** Model strings are normalized and matched flexibly, not exact.
7. **Incremental extraction.** Each milestone extracts one concern from the monolithic `index.ts`.

## File Map

```
extensions/gaud/
├── index.ts                 # Slimmed: UI, polling, tmux, routing, commands/tools
├── agent-types.ts           # (NEW) Type definitions
├── agent-registry.ts        # (NEW) Built-in agent definitions, discovery, factory
├── model-resolver.ts        # (NEW) 4-step model resolution pipeline
├── provider-detector.ts     # (NEW) Provider detection + cache
├── provider-cache.ts        # (NEW) Provider cache persistence
├── agent-launcher.ts        # (NEW) Agent command building, prompt injection
├── agent-config.ts          # (NEW) Config loading, role selection logic
├── config-schema.ts         # (NEW) Zod schema for JSONC config
├── config-loader.ts         # (NEW) Multi-level config loading
├── role-planner.ts          # (NEW) Capability-based role assignment
└── ui/                      # (existing) Dashboard component
```

## Test Plan

```
extensions/gaud/
├── agent-registry.test.ts   # Agent definition loading, discovery
├── model-resolver.test.ts   # Resolution ordering, fallback chains, fuzzy matching
├── provider-detector.test.ts # Provider detection logic
├── config-schema.test.ts    # Zod validation, migration
├── role-planner.test.ts     # Capability matching, agent diversity
└── agent-launcher.test.ts   # Command construction, prompt building
```
