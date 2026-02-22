---
name: kimi-k2.5
description: Multimodal agentic model specialized in vision-language tasks, coding from visual specs, and agent swarm coordination.
allowed-tools: Ollama, vision-processing, tool-use
version: 1.0
priority: HIGH
---

# Kimi K2.5 - Multimodal Agentic Specialist

Kimi K2.5 is a native multimodal agentic model integrated into Antigravity via Ollama. It excels in visual knowledge, cross-modal reasoning, and autonomous tool orchestration.

## Core Capabilities

| Capability | Description |
|------------|-------------|
| **Native Multimodality** | Seamlessly integrates vision and language for cross-modal reasoning. |
| **Coding with Vision** | Generates code from UI designs, wireframes, and video workflows. |
| **Agent Swarm** | Decomposes complex tasks into parallel sub-tasks for domain-specific agents. |
| **Thinking Mode** | Advanced reasoning for complex tool use and visual grounding. |

## Usage Patterns

### Vision-Grounded Reasoning
Use Kimi K2.5 to analyze visual outputs (images/videos) and provide cinematic or architectural feedback.
```bash
ollama run kimi-k2.5:cloud "Analyze this image and provide feedback on composition and color grading."
```

### UI-to-Code Orchestration
Provide a screenshot of a UI design and let Kimi K2.5 generate the implementation architecture.
```bash
ollama run kimi-k2.5:cloud "Generate the React/Tailwind code for this dashboard layout."
```

### Complex Tool Orchestration
Kimi K2.5 can be used to plan multi-step tool execution based on high-level goals.

## Rules for Antigravity
1. **Consult for Quality**: Use Kimi K2.5 to verify the aesthetic quality of generated images.
2. **Vision Specs**: When given a mockup or design file, invoke Kimi K2.5 to parse the visual requirements.
3. **Agentic Coordination**: For high-complexity tasks, use Kimi K2.5 to brainstorm a task breakdown.

---

*Note: This skill requires Ollama to be running locally with the `kimi-k2.5:cloud` model available.*
