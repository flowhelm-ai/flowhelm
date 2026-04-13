#!/usr/bin/env node

/**
 * SDK runner — thin wrapper for Claude Agent SDK inside a container.
 *
 * Called via `podman exec node /workspace/sdk-runner.js --message "..." ...`
 * Imports the Claude Agent SDK's query() function and outputs JSON to stdout.
 *
 * This file runs as ESM (the workspace package.json has "type": "module")
 * because @anthropic-ai/claude-agent-sdk is ESM-only.
 *
 * Args:
 *   --message <text>            User message (required)
 *   --max-turns <n>             Max agent turns (default: 25)
 *   --system-prompt <text>      Custom system prompt
 *   --append-system-prompt <text>  Memory context to append
 *   --mcp-config <path>         MCP config file path
 *   --resume <session-id>       Resume an existing session
 *   --allowed-tools <tools>     Comma-separated tool names
 *
 * Output: JSON object on stdout matching SdkRunnerOutput schema
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';

// ── Parse CLI Args ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--message': args.message = val; i++; break;
      case '--max-turns': args.maxTurns = parseInt(val, 10); i++; break;
      case '--system-prompt': args.systemPrompt = val; i++; break;
      case '--append-system-prompt': args.appendSystemPrompt = val; i++; break;
      case '--mcp-config': args.mcpConfig = val; i++; break;
      case '--resume': args.resume = val; i++; break;
      case '--allowed-tools': args.allowedTools = val; i++; break;
    }
  }
  return args;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (!args.message) {
    const output = {
      result: 'No message provided',
      is_error: true,
      session_id: '',
      num_turns: 0,
      input_tokens: 0,
      output_tokens: 0,
    };
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(1);
  }

  // Build query options
  const options = {
    prompt: args.message,
    maxTurns: args.maxTurns || 25,
    allowDangerouslySkipPermissions: true,
    permissionMode: 'bypassPermissions',
  };

  // System prompt
  if (args.systemPrompt) {
    options.systemPrompt = args.systemPrompt;
  }

  // Append memory context to system prompt
  if (args.appendSystemPrompt) {
    options.systemPrompt = (options.systemPrompt || '') + '\n\n' + args.appendSystemPrompt;
  }

  // Session resume
  if (args.resume) {
    options.resume = true;
    options.sessionId = args.resume;
  }

  // MCP servers from config file
  if (args.mcpConfig) {
    try {
      const configContent = readFileSync(args.mcpConfig, 'utf-8');
      const config = JSON.parse(configContent);
      if (config.mcpServers) {
        options.mcpServers = {};
        for (const [name, server] of Object.entries(config.mcpServers)) {
          options.mcpServers[name] = {
            command: server.command,
            args: server.args || [],
            env: server.env || {},
          };
        }
      }
    } catch (err) {
      process.stderr.write(`Warning: Failed to read MCP config: ${err.message}\n`);
    }
  }

  // Allowed tools
  if (args.allowedTools) {
    const toolNames = args.allowedTools.split(',').map(t => t.trim());
    options.allowedTools = toolNames;
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let numTurns = 0;
  let sessionId = args.resume || '';
  let resultText = '';
  let isError = false;

  try {
    // query() returns an AsyncIterable of messages
    for await (const message of query(options)) {
      // Track session ID from init message
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        sessionId = message.session_id;
      }

      // Count turns from assistant messages
      if (message.type === 'assistant') {
        numTurns++;
      }

      // Capture final result
      if (message.type === 'result') {
        resultText = message.result || '';
        isError = !!message.is_error;
        totalInputTokens = message.total_input_tokens || 0;
        totalOutputTokens = message.total_output_tokens || 0;
      }
    }
  } catch (err) {
    resultText = err.message || 'SDK query failed';
    isError = true;
  }

  const output = {
    result: resultText,
    is_error: isError,
    session_id: sessionId,
    num_turns: numTurns,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
  };

  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(isError ? 1 : 0);
}

main().catch((err) => {
  const output = {
    result: err.message || 'Unexpected error',
    is_error: true,
    session_id: '',
    num_turns: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(1);
});
